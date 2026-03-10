const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const PASSWORD = 'Abdulloh29';

const INSTAGRAM_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/i;
const YOUTUBE_RE = /(?:https?:\/\/)?(?:(?:www|m)\.)?(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/i;

// In-memory state (persists across warm serverless invocations)
const authorizedUsers = new Set();
const pendingLinks = new Map(); // chatId -> youtubeUrl

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

// --- YouTube agent with cookies (fixes "Sign in to confirm you're not a bot") ---

function getYtdlOptions() {
  const ytdl = require('@distube/ytdl-core');
  const opts = {};
  if (process.env.YT_COOKIES) {
    try {
      opts.agent = ytdl.createAgent(JSON.parse(process.env.YT_COOKIES));
    } catch (e) {
      console.error('Failed to create ytdl agent from YT_COOKIES:', e.message);
    }
  }
  return opts;
}

// --- Instagram extraction via oembed API ---

async function extractInstagram(url) {
  const cleanUrl = url.split('?')[0];

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

async function extractYouTube(url, format) {
  const ytdl = require('@distube/ytdl-core');
  const opts = getYtdlOptions();
  const info = await ytdl.getInfo(url, opts);
  const title = info.videoDetails.title;

  if (format === 'audio') {
    const formats = info.formats
      .filter(f => f.hasAudio && !f.hasVideo)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));

    let fmt = formats.find(f => f.contentLength && parseInt(f.contentLength) < 50 * 1024 * 1024);
    if (!fmt) fmt = formats[0];
    if (!fmt) return null;

    return { type: 'audio', url: fmt.url, title, size: parseInt(fmt.contentLength || '0') };
  }

  // Video format
  const formats = info.formats
    .filter(f => f.hasVideo && f.hasAudio)
    .sort((a, b) => (a.height || 0) - (b.height || 0));

  let fmt = formats.find(f => f.height <= 720 && f.contentLength && parseInt(f.contentLength) < 50 * 1024 * 1024);
  if (!fmt) fmt = formats.find(f => f.height <= 480);
  if (!fmt) fmt = formats[0];
  if (!fmt) return null;

  return { type: 'video', url: fmt.url, title, size: parseInt(fmt.contentLength || '0') };
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

  let method, field, ext, mime;
  if (type === 'audio') {
    method = 'sendAudio';
    field = 'audio';
    ext = 'mp3';
    mime = 'audio/mpeg';
  } else if (type === 'video') {
    method = 'sendVideo';
    field = 'video';
    ext = 'mp4';
    mime = 'video/mp4';
  } else {
    method = 'sendPhoto';
    field = 'photo';
    ext = 'jpg';
    mime = 'image/jpeg';
  }

  form.append(field, buffer, { filename: `media.${ext}`, contentType: mime });
  if (caption) form.append('caption', caption.slice(0, 1024));
  if (type === 'video') form.append('supports_streaming', 'true');
  if (type === 'audio') form.append('title', (caption || 'audio').slice(0, 256));

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

  const { message, callback_query } = req.body || {};

  // --- Handle callback queries (YouTube format selection) ---
  if (callback_query) {
    const cbChatId = callback_query.message.chat.id;
    const cbData = callback_query.data;

    await tg('answerCallbackQuery', { callback_query_id: callback_query.id });

    const url = pendingLinks.get(cbChatId);
    if (!url) {
      await sendMsg(cbChatId, 'Session expired. Please send the link again.');
      return res.status(200).json({ ok: true });
    }

    pendingLinks.delete(cbChatId);

    if (cbData === 'yt_video' || cbData === 'yt_audio') {
      const format = cbData === 'yt_audio' ? 'audio' : 'video';
      await sendAction(cbChatId, format === 'audio' ? 'upload_document' : 'upload_video');
      await sendMsg(cbChatId, `Downloading ${format}...`);

      try {
        const media = await extractYouTube(url, format);
        if (!media) {
          await sendMsg(cbChatId, 'Could not extract media from this link.');
          return res.status(200).json({ ok: true });
        }

        const result = await downloadAndSend(cbChatId, media.url, media.type, media.title);
        if (!result.ok) {
          await sendMsg(cbChatId, `<b>${media.title}</b>\n\nFile too large (Telegram 50MB limit).`);
        }
      } catch (e) {
        await sendMsg(cbChatId, `Error: ${e.message}`);
      }
    }

    return res.status(200).json({ ok: true });
  }

  // --- Handle messages ---
  if (!message?.text) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const text = message.text.trim();

  try {
    // /start
    if (text === '/start') {
      await sendMsg(chatId, 'Please enter the password to use this bot:');
      return res.status(200).json({ ok: true });
    }

    // Password check
    if (text === PASSWORD) {
      authorizedUsers.add(chatId);
      await sendMsg(chatId, '<b>Access granted!</b>\n\nSend me a YouTube or Instagram link and I\'ll download it for you.');
      return res.status(200).json({ ok: true });
    }

    // Authorization check
    if (!authorizedUsers.has(chatId)) {
      await sendMsg(chatId, 'Please enter the correct password first.\nSend /start to begin.');
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

      const field = media.type === 'video' ? 'video' : 'photo';
      const method = media.type === 'video' ? 'sendVideo' : 'sendPhoto';
      const urlResult = await tg(method, {
        chat_id: chatId,
        [field]: media.url,
        caption,
      });

      if (!urlResult.ok) {
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
      pendingLinks.set(chatId, text);
      await tg('sendMessage', {
        chat_id: chatId,
        text: 'Choose download format:',
        reply_markup: {
          inline_keyboard: [[
            { text: 'Video', callback_data: 'yt_video' },
            { text: 'Audio', callback_data: 'yt_audio' },
          ]],
        },
      });
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
