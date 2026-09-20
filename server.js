const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const app = express();
const upload = multer({
  dest: path.join(os.tmpdir(), "ranking-uploads")
});

app.use(express.json());

const PORT = process.env.PORT || 10000;
const RENDER_SERVICE_KEY = process.env.RENDER_SERVICE_KEY;

function checkAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const expected = `Bearer ${RENDER_SERVICE_KEY}`;

  if (!RENDER_SERVICE_KEY || auth !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Ranking Video FFmpeg Renderer"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

app.post(
  "/render",
  checkAuth,
  upload.fields([
    { name: "clips", maxCount: 5 },
    { name: "narration", maxCount: 1 },
    { name: "music", maxCount: 1 }
  ]),
  async (req, res) => {
    const jobId = crypto.randomUUID();
    const workDir = path.join(os.tmpdir(), `ranking-${jobId}`);

    try {
      fs.mkdirSync(workDir, { recursive: true });

      const clips = req.files?.clips || [];

      if (clips.length === 0) {
        return res.status(400).json({
          error: "No video clips were provided."
        });
      }

      const title = req.body.title || "Top 5";
      const ranking = req.body.ranking
        ? JSON.parse(req.body.ranking)
        : clips.map((_, i) => 5 - i);

      /*
       * Move uploaded clips into our job folder.
       */
      const clipFiles = [];

      for (let i = 0; i < clips.length; i++) {
        const source = clips[i].path;
        const destination = path.join(workDir, `clip-${i}.mp4`);

        fs.renameSync(source, destination);

        clipFiles.push({
          path: destination,
          rank: ranking[i] || (5 - i)
        });
      }

      /*
       * Create one normalized 9:16 video for each clip.
       */
      const normalized = [];

      for (let i = 0; i < clipFiles.length; i++) {
        const input = clipFiles[i].path;
        const output = path.join(workDir, `normalized-${i}.mp4`);
        const rank = clipFiles[i].rank;

        await runFFmpeg([
          "-y",
          "-i", input,

          "-vf",
          `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='NUMBER ${rank}':fontcolor=white:fontsize=90:box=1:boxcolor=black@0.65:boxborderw=25:x=50:y=100`,

          "-r", "30",
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "23",

          "-c:a", "aac",
          "-ar", "48000",
          "-ac", "2",

          output
        ]);

        normalized.push(output);
      }

      /*
       * Create FFmpeg concat list.
       */
      const concatFile = path.join(workDir, "concat.txt");

      const concatText = normalized
        .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
        .join("\n");

      fs.writeFileSync(concatFile, concatText);

      const silentVideo = path.join(workDir, "combined.mp4");

      await runFFmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFile,
        "-c", "copy",
        silentVideo
      ]);

      /*
       * Add narration/music if supplied.
       */
      const narration = req.files?.narration?.[0];
      const music = req.files?.music?.[0];

      const finalVideo = path.join(workDir, "final.mp4");

      if (narration || music) {
        const inputs = ["-i", silentVideo];

        if (narration) {
          inputs.push("-i", narration.path);
        }

        if (music) {
          inputs.push("-i", music.path);
        }

        const filters = [];
        const audioInputs = [];

        if (narration) {
          audioInputs.push("[1:a]");
        }

        if (music) {
          const musicIndex = narration ? 2 : 1;

          filters.push(
            `[${musicIndex}:a]volume=0.15[music]`
          );

          audioInputs.push("[music]");
        }

        if (audioInputs.length > 1) {
          filters.push(
            `${audioInputs.join("")}amix=inputs=${audioInputs.length}:duration=first[aout]`
          );
        } else if (audioInputs.length === 1) {
          filters.push(
            `${audioInputs[0]}anull[aout]`
          );
        }

        await runFFmpeg([
          "-y",
          ...inputs,
          "-filter_complex",
          filters.join(";"),
          "-map", "0:v:0",
          "-map", "[aout]",
          "-c:v", "copy",
          "-c:a", "aac",
          "-shortest",
          finalVideo
        ]);
      } else {
        fs.copyFileSync(silentVideo, finalVideo);
      }

      /*
       * Return the finished MP4 directly.
       */
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="ranking-video-${jobId}.mp4"`
      );

      const stream = fs.createReadStream(finalVideo);

      stream.on("close", () => {
        cleanup(workDir);
      });

      stream.pipe(res);

    } catch (error) {
      console.error(error);

      cleanup(workDir);

      res.status(500).json({
        error: "Video rendering failed.",
        details: error.message
      });
    }
  }
);

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, {
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(stderr);
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function cleanup(directory) {
  fs.rm(directory, {
    recursive: true,
    force: true
  }, () => {});
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ranking Video Renderer running on port ${PORT}`);
});
