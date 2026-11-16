const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs/promises');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

const API_BASE = 'https://apihub.agnes-ai.com/v1';
const POLL_BASE = 'https://apihub.agnes-ai.com/agnesapi';
const MODEL_VIDEO = 'agnes-video-v2.0';
const PORT = process.env.PORT || 3000;
const API_KEY = 'sk-26bYqEC2CJdxCSQmThti4kztHROyWeiFYGJXG16HWgKcb2jp'; 

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/videos', express.static(path.join(__dirname, 'videos')));
app.use('/frames', express.static(path.join(__dirname, 'frames')));
const upload = multer({ dest: 'uploads/' });

// Création des dossiers
fs.mkdir(path.join(__dirname, 'videos'), { recursive: true }).catch(() => {});
fs.mkdir(path.join(__dirname, 'frames'), { recursive: true }).catch(() => {});
fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true }).catch(() => {});

// PAGE HTML INTÉGRÉE
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blackout 72H</title>
<style>
body{background:#0a0a0f;color:#e8e6e0;font-family:sans-serif;padding:20px;text-align:center}
.panel{border:1px solid #333;padding:20px;border-radius:8px;margin-bottom:20px;background:#12121a}
.btn{background:#ff3b3b;color:white;padding:15px 30px;border:none;border-radius:8px;font-size:18px;cursor:pointer;width:100%}
video{width:100%;display:none;margin-top:20px;border-radius:8px}
</style>
</head>
<body>
<h1>Blackout 72H</h1>
<div class="panel">
  <input type="file" id="file" accept="image/*" onchange="document.getElementById('btn').disabled=false">
</div>
<button class="btn" id="btn" onclick="generate()" disabled>Générer la vidéo (60s)</button>
<video id="result" controls></video>
<script>
async function generate() {
  const btn = document.getElementById('btn');
  btn.innerText = "Génération... (5 min)";
  btn.disabled = true;
  try {
    const file = document.getElementById('file').files[0];
    const formData = new FormData();
    formData.append('reference', file);
    const res = await fetch('/generate-episode', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    document.getElementById('result').src = data.url;
    document.getElementById('result').style.display = 'block';
    btn.innerText = "Vidéo prête !";
  } catch (err) {
    alert("Erreur : " + err.message);
    btn.innerText = "Réessayer";
    btn.disabled = false;
  }
}
</script>
</body>
</html>
  `);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiFetch(url, options = {}) {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url, { ...options, headers: { ...options.headers, 'Authorization': 'Bearer ' + API_KEY } });
      if (res.ok) return res;
      if (res.status === 429) { await sleep(30000); continue; }
      if (res.status >= 500) { await sleep(15000); continue; }
      throw new Error('HTTP ' + res.status);
    } catch (e) {
      if (i === 5) throw e;
      await sleep(5000);
    }
  }
}

async function generateVideo(prompt, imageUrl, numFrames) {
  const body = { model: MODEL_VIDEO, prompt, num_frames: numFrames, frame_rate: 24 };
  if (imageUrl) body.image = imageUrl;
  const res = await apiFetch(API_BASE + '/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch(e) { throw new Error("Réponse invalide d'Agnes"); }
  const id = data.video_id || data.id || data.task_id;
  if (!id) throw new Error('Pas de video_id');
  return id;
}

async function pollVideo(id) {
  let wait = 60; while (wait > 0) { await sleep(1000); wait--; }
  for (let i = 0; i < 100; i++) {
    await sleep(i === 0 ? 0 : 12000);
    const res = await apiFetch(POLL_BASE + '?video_id=' + encodeURIComponent(id) + '&model_name=' + MODEL_VIDEO);
    const d = await res.json();
    if (d.status === 'completed' || d.status === 'succeeded' || d.status === 'done') return d.metadata?.url || d.url || d.output?.url;
    if (d.status === 'failed') throw new Error('Échec');
  }
  throw new Error('Timeout');
}

async function download(url, out) { const res = await fetch(url); await fs.writeFile(out, Buffer.from(await res.arrayBuffer())); return out; }
async function extractLastFrame(video, out) { return new Promise((res, rej) => { ffmpeg(video).outputOptions(['-sseof', '-1', '-update', '1', '-q:v', '1', '-f', 'image2', '-vcodec', 'png']).on('end', () => res(out)).on('error', rej).save(out); }); }
async function concat(videos, out) { const list = out + '.txt'; await fs.writeFile(list, videos.map(v => `file '${path.resolve(v)}'`).join('\n')); return new Promise((res, rej) => { ffmpeg().input(list).inputOptions(['-f', 'concat', '-safe', '0']).outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p']).on('end', () => { fs.unlink(list).catch(() => {}); res(out); }).on('error', rej).save(out); }); }

app.post('/generate-episode', upload.single('reference'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Photo manquante');
    const refBuf = await fs.readFile(req.file.path);
    const refBase64 = `data:${req.file.mimetype};base64,${refBuf.toString('base64')}`;
    const clipPaths = []; let currentImage = refBase64;

    for (let c = 0; c < 4; c++) {
      const clipPath = path.join(__dirname, 'videos', `clip_${uuidv4()}.mp4`);
      const framePath = path.join(__dirname, 'frames', `frame_${uuidv4()}.png`);
      const prompt = `Cinematic TikTok series Blackout 72H. Character wakes up in an abandoned hospital. Clip ${c+1}/4.`;
      
      let id;
      try { id = await generateVideo(prompt, currentImage, 361); } 
      catch (err) { id = await generateVideo(prompt, null, 361); }

      const url = await pollVideo(id);
      await download(url, clipPath);
      clipPaths.push(clipPath);
      
      if (c < 3) {
        try { await extractLastFrame(clipPath, framePath); currentImage = `${req.protocol}://${req.get('host')}/frames/${path.basename(framePath)}`; } 
        catch (e) { currentImage = null; }
      }
    }
    const finalPath = path.join(__dirname, 'videos', `episode_${uuidv4()}.mp4`);
    await concat(clipPaths, finalPath);
    await fs.unlink(req.file.path).catch(() => {});
    res.json({ success: true, url: `${req.protocol}://${req.get('host')}/videos/${path.basename(finalPath)}` });
  } catch (e) { res.status(500).send(e.message); }
});

app.listen(PORT, () => console.log('Serveur prêt sur le port ' + PORT));
