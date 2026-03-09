const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const INSTAGRAM_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/i;
const YOUTUBE_RE = /(?:https?:\/\/)?(?:(?:www|m)\.)?(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/i;

// --- Telegram helpers ---

async function tg(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function sendMsg(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

function sendAction(chatId, action) {
  return tg('sendChatAction', { chat_id: chatId, action });
}

// --- Instagram extraction via oembed API ---

async function extractInstagram(url) {
  // Clean URL (remove tracking params)
  const cleanUrl = url.split('?')[0];

  // Method 1: oembed API (most reliable for public posts)
  try {
    const oembedUrl = `https://i.instagram.com/api/v1/oembed/?url=${encodeURIComponent(cleanUrl)}`;
    const res = await fetch(oembedUrl);
    if (res.ok) {
      const data = await res.json();
      if (data.thumbnail_url) {
        return {
          type: 'image',
          url: data.thumbnail_url,
          title: data.title || '',
          author: data.author_name || '',
        };
      }
    }
  } catch (e) {
    console.error('IG oembed failed:', e.message);
  }

  // Method 2: scrape page for og: tags (fallback)
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'text/html',
  };

  try {
    const res = await fetch(url, { headers, redirect: 'follow' });
    const html = await res.text();

    let m = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"/i)
         || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"/i);
    if (m) return { type: 'video', url: m[1].replace(/&amp;/g, '&') };

    m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
    if (m) return { type: 'image', url: m[1].replace(/&amp;/g, '&') };
  } catch (e) {
    console.error('IG scrape failed:', e.message);
  }

  return null;
}

// --- YouTube extraction ---

async function extractYouTube(url) {
  const ytdl = require('@distube/ytdl-core');
  const info = await ytdl.getInfo(url);
  const title = info.videoDetails.title;

  const formats = info.formats
    .filter(f => f.hasVideo && f.hasAudio)
    .sort((a, b) => (a.height || 0) - (b.height || 0));

  let format = formats.find(f => f.height <= 720 && f.contentLength && parseInt(f.contentLength) < 50 * 1024 * 1024);
  if (!format) format = formats.find(f => f.height <= 480);
  if (!format) format = formats[0];
  if (!format) return null;

  return {
    type: 'video',
    url: format.url,
    title,
    size: parseInt(format.contentLength || '0'),
  };
}

// --- Download media buffer and upload to Telegram ---

async function downloadAndSend(chatId, mediaUrl, type, caption) {
  const res = await fetch(mediaUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1000) throw new Error('Downloaded file too small');

  const form = new FormData();
  form.append('chat_id', chatId.toString());

  const method = type === 'video' ? 'sendVideo' : 'sendPhoto';
  const field = type === 'video' ? 'video' : 'photo';
  const ext = type === 'video' ? 'mp4' : 'jpg';
  const mime = type === 'video' ? 'video/mp4' : 'image/jpeg';

  form.append(field, buffer, { filename: `media.${ext}`, contentType: mime });
  if (caption) form.append('caption', caption.slice(0, 1024));
  if (type === 'video') form.append('supports_streaming', 'true');

  const result = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });

  return result.json();
}

// --- Webhook handler ---

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Bot is running' });
  }

  const { message } = req.body || {};
  if (!message?.text) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const text = message.text.trim();

  try {
    // /start
    if (text === '/start') {
      await sendMsg(chatId, '<b>Welcome!</b>\n\nSend me a YouTube or Instagram link and I\'ll download it for you.');
      return res.status(200).json({ ok: true });
    }

    // --- Instagram ---
    if (INSTAGRAM_RE.test(text)) {
      await sendAction(chatId, 'upload_photo');
      await sendMsg(chatId, 'Processing Instagram link...');

      const media = await extractInstagram(text);
      if (!media) {
        await sendMsg(chatId, 'Could not extract media. The post might be private.');
        return res.status(200).json({ ok: true });
      }

      const caption = media.author
        ? `${media.title ? media.title.slice(0, 200) + '\n\n' : ''}@${media.author} on Instagram`
        : 'Downloaded from Instagram';

      // Try sending by URL first (works for Instagram CDN URLs)
      const field = media.type === 'video' ? 'video' : 'photo';
      const method = media.type === 'video' ? 'sendVideo' : 'sendPhoto';
      const urlResult = await tg(method, {
        chat_id: chatId,
        [field]: media.url,
        caption,
      });

      if (!urlResult.ok) {
        // Fallback: download and re-upload
        try {
          const uploadResult = await downloadAndSend(chatId, media.url, media.type, caption);
          if (!uploadResult.ok) {
            await sendMsg(chatId, `Here's the direct link:\n${media.url}`);
          }
        } catch {
          await sendMsg(chatId, `Here's the direct link:\n${media.url}`);
        }
      }

      return res.status(200).json({ ok: true });
    }

    // --- YouTube ---
    if (YOUTUBE_RE.test(text)) {
      await sendAction(chatId, 'upload_video');
      await sendMsg(chatId, 'Processing YouTube link...');

      const media = await extractYouTube(text);
      if (!media) {
        await sendMsg(chatId, 'Could not extract video from this link.');
        return res.status(200).json({ ok: true });
      }

      try {
        const result = await downloadAndSend(chatId, media.url, 'video', media.title);
        if (!result.ok) {
          await sendMsg(chatId, `<b>${media.title}</b>\n\nVideo is too large (Telegram 50MB limit).`);
        }
      } catch (e) {
        await sendMsg(chatId, `<b>${media.title}</b>\n\nError: ${e.message}`);
      }

      return res.status(200).json({ ok: true });
    }

    // Unknown message
    await sendMsg(chatId, 'Send me a YouTube or Instagram link to download.');
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook error:', err);
    try {
      await sendMsg(chatId, `Error: ${err.message}`);
    } catch { /* ignore */ }
    return res.status(200).json({ ok: true });
  }
};
