import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const ServePort = 5181
const VidsDir = path.join(process.cwd(), 'media')
const OutputDir = path.join(process.cwd(), 'public', 'live')
const SegmentDuration = 10
let playbackTime = 0
let isRunning = false
if (!fs.existsSync(OutputDir)) {
    fs.mkdirSync(OutputDir, { recursive: true })
}

if (!fs.existsSync(VidsDir)) {
    fs.mkdirSync(VidsDir, { recursive: true })
    console.log(`bodacious humphrey willaism ${VidsDir}`)
}

function concat() {
    const concatpath = path.join(OutputDir, 'concat.txt')
    const files = fs.readdirSync(VidsDir)
        .filter(file => file.endsWith('.mp4'))
        .map(file => `file '${path.join(VidsDir, file)}'`)
        .join('\n')
    fs.writeFileSync(concatpath, files)
    return concatpath
}

function generateSegment(segmentIndex) {
    const segmentFile = path.join(OutputDir, `segment-${segmentIndex}.ts`)
    if (fs.existsSync(segmentFile)) return segmentFile

    const startTime = segmentIndex * SegmentDuration
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-y', '-ss', `${startTime}`,
            '-i', `concat:${concat()}`,
            '-t', `${SegmentDuration}`,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-c:a', 'aac',
            '-f', 'mpegts',
            segmentFile
        ])
        ffmpeg.on('close', (code) => code === 0 ? resolve(segmentFile) : reject(new Error(`FFmpeg exit ${code}`)))
    })
}

function M3U8() {
    const segmentIndex = Math.floor(playbackTime / SegmentDuration)
    const targetDuration = SegmentDuration + 1
    let playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-MEDIA-SEQUENCE:${segmentIndex}
`
    for (let i = 0; i < 3; i++) {
        playlist += `#EXTINF:${SegmentDuration},
segment-${segmentIndex + i}.ts
`
    }
    return playlist
}

function tick() {
    if (isRunning) {
        playbackTime += 0.1
        setTimeout(tick, 100)
    }
}

const server = http.createServer(async (req, res) => {
    if (!req.url || !req.headers.host) {
        res.writeHead(400)
        res.end('Bad request')
        return
    }
    const { pathname } = new URL(req.url, `http://${req.headers.host}`)

    if (pathname === '/play.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        res.end(M3U8())
    } else if (pathname.match(/^\/segment-\d+\.ts$/)) {
        const segmentFile = path.join(OutputDir, pathname.slice(1))
        if (!fs.existsSync(segmentFile)) {
            const match = pathname.match(/\d+/)
            const segmentIndex = parseInt(match ? match[0] : '0')
            try {
                await generateSegment(segmentIndex)
            } catch (e) {
                res.writeHead(404)
                res.end('Segment not found')
                return
            }
        }
        res.writeHead(200, { 'Content-Type': 'video/mp2t' })
        res.end(fs.readFileSync(segmentFile))
    } else if (pathname === '/start') {
        isRunning = true
        playbackTime = 0
        tick()
        res.writeHead(200)
        res.end('Started')
    } else if (pathname === '/stop') {
        isRunning = false
        res.writeHead(200)
        res.end('Stopped')
    } else {
        res.writeHead(404)
        res.end('Not found')
    }
})
server.listen(ServePort, () => console.log(`started!`))