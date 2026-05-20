const fs = require('fs');
const path = require('path');
const http = require('http');
const AdmZip = require('adm-zip');

const PORT = 8080;
const ZIP_NAME = `project-share-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
const OUTPUT_PATH = path.join(__dirname, ZIP_NAME);

async function run() {
    try {
        // 1. Create ZIP
        console.log('📦 Initializing project archival...');
        const zip = new AdmZip();

        const filesToInclude = [
            'index.js',
            'package.json',
            'package-lock.json',
            'config.json',
            'README.md',
            'GEMINI.md',
            'share.js',
            'app.py',
            'lib',
            'plugins'
        ];

        let count = 0;
        filesToInclude.forEach(file => {
            const fullPath = path.join(__dirname, file);
            if (fs.existsSync(fullPath)) {
                const stats = fs.statSync(fullPath);
                if (stats.isDirectory()) {
                    zip.addLocalFolder(fullPath, file);
                    console.log(`  + Folder: ${file}`);
                } else {
                    zip.addLocalFile(fullPath);
                    console.log(`  + File:   ${file}`);
                }
                count++;
            }
        });

        if (count === 0) {
            console.error('❌ No files found to archive! check your directory.');
            process.exit(1);
        }

        zip.writeZip(OUTPUT_PATH);
        console.log(`✅ Archive created: ${OUTPUT_PATH}`);

        // 2. Start Temporary Server
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            console.log(`[${new Date().toLocaleTimeString()}] Request: ${url.pathname}`);

            if (url.pathname === '/download') {
                console.log('📥 Download triggered...');
                if (!fs.existsSync(OUTPUT_PATH)) {
                    res.writeHead(404);
                    return res.end('Error: Zip file missing on server.');
                }

                const stat = fs.statSync(OUTPUT_PATH);
                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Length': stat.size,
                    'Content-Disposition': `attachment; filename=${ZIP_NAME}`
                });

                const readStream = fs.createReadStream(OUTPUT_PATH);
                readStream.pipe(res);

                readStream.on('end', () => {
                    console.log('✅ Download complete.');
                });

            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Puru Project Share</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background-color: #f4f7f6; }
        .card { background: white; padding: 2.5rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 90%; }
        h1 { color: #2c3e50; margin-bottom: 0.5rem; font-size: 1.5rem; }
        p { color: #7f8c8d; margin-bottom: 2rem; }
        .btn { display: inline-block; background-color: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; transition: background 0.2s; box-shadow: 0 4px 6px rgba(52, 152, 219, 0.2); }
        .btn:hover { background-color: #2980b9; }
        .footer { margin-top: 1.5rem; font-size: 0.8rem; color: #bdc3c7; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Project is Ready!</h1>
        <p>Your archive <strong>${ZIP_NAME}</strong> has been generated and is ready for download.</p>
        <a href="/download" class="btn">🚀 DOWNLOAD ZIP</a>
        <div class="footer">
            Server is running. Press Ctrl+C in terminal to stop.
        </div>
    </div>
</body>
</html>
                `);
            }
        });

        // Cleanup on manual termination
        const cleanup = () => {
            console.log('\n🧹 Cleaning up temporary files...');
            try {
                if (fs.existsSync(OUTPUT_PATH)) fs.unlinkSync(OUTPUT_PATH);
                console.log('🗑️ Deleted temporary zip file.');
            } catch (e) {}
            process.exit();
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`\n🚀 SHARE SERVER ACTIVE (Persistent Mode)`);
            console.log(`🔗 Access here: http://0.0.0.0:${PORT}`);
            console.log(`📂 Serving: ${ZIP_NAME}`);
            console.log(`-------------------------------------------`);
            console.log(`Press Ctrl+C to stop server and cleanup.`);
        });

    } catch (err) {
        console.error('FATAL ERROR:', err);
        process.exit(1);
    }
}

run();
