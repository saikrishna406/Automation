import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import { config } from '../config';
import { StorageResult } from '../types';

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

export function getAuthUrl(userId: string): string {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    state: userId, // passed back in callback for user lookup
    prompt: 'consent',
  });
}

export async function exchangeCodeForTokens(code: string) {
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

// ─── Upload to Drive ──────────────────────────────────────────────────────────
export async function uploadToDrive(
  videoUrl: string,
  fileName: string,
  jobId: string,
  googleTokens: any
): Promise<StorageResult> {
  // Set credentials (refresh token handles expiry automatically)
  oauth2Client.setCredentials(googleTokens);

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  // ── 1. Download video to temp ─────────────────────────────────────────────
  const tmpPath = path.join(os.tmpdir(), `final_${jobId}.mp4`);
  const res = await axios.get(videoUrl, { responseType: 'arraybuffer' });
  fs.writeFileSync(tmpPath, Buffer.from(res.data));

  // ── 2. Ensure folder exists ────────────────────────────────────────────────
  const folderId = await ensureDateFolder(drive);

  // ── 3. Upload file ─────────────────────────────────────────────────────────
  const uploadRes = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: 'video/mp4',
    },
    media: {
      mimeType: 'video/mp4',
      body: fs.createReadStream(tmpPath),
    },
    fields: 'id, webViewLink, name',
  });

  fs.unlinkSync(tmpPath);

  const fileId = uploadRes.data.id!;
  const driveUrl = uploadRes.data.webViewLink!;

  // ── 4. Set shareable link ──────────────────────────────────────────────────
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone', // or 'user' with specific email
    },
  });

  return {
    driveFileId: fileId,
    driveUrl,
    driveFolderPath: `AI Videos/${getTodayFolder()}`,
  };
}

// ─── Folder Management ────────────────────────────────────────────────────────
async function ensureDateFolder(drive: any): Promise<string> {
  const folderName = getTodayFolder();

  // Search for existing folder inside root AI Videos folder
  const searchRes = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${config.google.driveFolderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
  });

  if (searchRes.data.files?.length > 0) {
    return searchRes.data.files[0].id;
  }

  // Create folder
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [config.google.driveFolderId],
    },
    fields: 'id',
  });

  return createRes.data.id!;
}

function getTodayFolder(): string {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}
