"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const ServePort = 5181;
const VidsDir = node_path_1.default.join(process.cwd(), 'media');
const OutputDir = node_path_1.default.join(process.cwd(), 'live');
const SegmentDuration = 10;
const PublicBaseUrl = process.env.basehost?.replace(/\/+$/, '');
const ffmpegCheck = (0, node_child_process_1.spawnSync)('ffmpeg', ['-version'], { stdio: 'ignore' });
const HasFfmpeg = !ffmpegCheck.error && ffmpegCheck.status === 0;
let playbackTime = 0;
let isRunning = false;
if (!node_fs_1.default.existsSync(OutputDir)) {
node_fs_1.default.mkdirSync(OutputDir, { recursive: true });
}
if (!node_fs_1.default.existsSync(VidsDir)) {
    node_fs_1.default.mkdirSync(VidsDir, { recursive: true });
}
function concat() {
    const concatPath = node_path_1.default.join(OutputDir, 'concat.txt');
    const files = node_fs_1.default
        .readdirSync(VidsDir)
        .filter((file) => file.endsWith('.mp4'))
        .map((file) => `file '${node_path_1.default.join(VidsDir, file)}'`)
        .join('\n');
    node_fs_1.default.writeFileSync(concatPath, files);
    return concatPath;
}
function generateSegment(segmentIndex) {
    const segmentFile = node_path_1.default.join(OutputDir, `segment-${segmentIndex}.ts`);
    if (node_fs_1.default.existsSync(segmentFile)) {
        return Promise.resolve(segmentFile);
    }
    const startTime = segmentIndex * SegmentDuration;
    return new Promise((resolve, reject) => {
        const ffmpeg = (0, node_child_process_1.spawn)('ffmpeg', [
            '-y',
            '-ss',
            `${startTime}`,
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            concat(),
            '-t',
            `${SegmentDuration}`,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-c:a',
            'aac',
            '-f',
            'mpegts',
            segmentFile,
        ]);
        ffmpeg.on('error', (err) => {
            reject(new Error(`FFmpeg spawn failed: ${err.message}`));
        });
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve(segmentFile);
            }
            else {
                reject(new Error(`FFmpeg exit ${code}`));
            }
        });
    });
}
function firstHeaderValue(value) {
    if (!value) {
        return '';
    }
    return (Array.isArray(value) ? value[0] : value).split(',')[0].trim();
}
function getBaseUrl(req) {
    if (PublicBaseUrl) {
        return PublicBaseUrl;
    }
    const proto = firstHeaderValue(req.headers['x-forwarded-proto']) || 'http';
    const host = firstHeaderValue(req.headers['x-forwarded-host']) || req.headers.host;
    return `${proto}://${host}`;
}
function m3u8(baseUrl) {
    const segmentIndex = Math.floor(playbackTime / SegmentDuration);
    const targetDuration = SegmentDuration + 1;
    let playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${targetDuration}\n#EXT-X-MEDIA-SEQUENCE:${segmentIndex}\n`;
    for (let i = 0; i < 3; i++) {
        playlist += `#EXTINF:${SegmentDuration},\n${baseUrl}/live/segment-${segmentIndex + i}.ts\n`;
    }
    return playlist;
}
function tick() {
    if (!isRunning) {
        return;
    }
    playbackTime += 0.1;
    setTimeout(tick, 100);
}
const server = node_http_1.default.createServer(async (req, res) => {
    if (!req.url || !req.headers.host) {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
    }
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname === '/live/stream.m3u8') {
        const videoCount = node_fs_1.default.readdirSync(VidsDir).filter((f) => f.endsWith('.mp4')).length;
        if (videoCount === 0) {
            res.statusCode = 404;
            res.end('No videos available');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(m3u8(getBaseUrl(req)));
        return;
    }
    if (/^\/live\/segment-\d+\.ts$/.test(pathname)) {
        if (!HasFfmpeg) {
            res.statusCode = 503;
            res.end('FFmpeg is not installed on this server');
            return;
        }
        const segmentFile = node_path_1.default.join(OutputDir, pathname.slice('/live/'.length));
        if (!node_fs_1.default.existsSync(segmentFile)) {
            const match = pathname.match(/\d+/);
            const segmentIndex = Number.parseInt(match ? match[0] : '0', 10);
            try {
                await generateSegment(segmentIndex);
            }
            catch {
                res.statusCode = 404;
                res.end('Segment not found');
                return;
            }
        }
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end(node_fs_1.default.readFileSync(segmentFile));
        return;
    }
    if (pathname === '/start') {
        isRunning = true;
        playbackTime = 0;
        tick();
        res.end('Started');
        return;
    }
    if (pathname === '/stop') {
        isRunning = false;
        res.end('Stopped');
        return;
    }
    res.statusCode = 404;
    res.end('Not found');
});
server.listen(ServePort, () => {
    console.log(`lovely`);
});
