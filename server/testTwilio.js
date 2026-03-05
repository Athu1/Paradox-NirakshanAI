import { sendSmsAlert, triggerVoiceCall } from './twilioService.js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env manually since we keep it simple
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
        const [k, ...v] = line.trim().split('=');
        if (k && v.length) process.env[k] = v.join('=').trim();
    }
}

async function run() {
    console.log("Testing Twilio SMS to", process.env.ALERT_PHONE_NUMBER);
    try {
        const res = await sendSmsAlert({
            severity: 'CRITICAL',
            cameraId: 'TEST-001',
            type: 'Test Event',
            confidence: 99,
            description: 'This is a test message from the CLI'
        });
        console.log("SMS Success:", res);
    } catch (e) {
        console.error("SMS Error:", e.message);
        if (e.code) console.error("Twilio Error Code:", e.code);
    }
}

run();
