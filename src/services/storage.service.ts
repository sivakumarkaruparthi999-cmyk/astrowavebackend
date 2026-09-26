import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const UPLOAD_DIR = process.env.STORAGE_PATH || process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5001}`;

// Ensure base upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Subdirectories for structured storage
const folders = ['avatars', 'documents', 'pooja', 'chat', 'reports'];
folders.forEach((folder) => {
  const dir = path.join(UPLOAD_DIR, folder);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const DANGEROUS_EXTENSIONS = ['.exe', '.sh', '.bat', '.php', '.js', '.py', '.svg', '.html', '.htm', '.jsp', '.asp', '.dll', '.cmd'];

/**
 * Validates filename against path traversal, dangerous extensions, and double extensions
 */
export function isSafeFilename(originalName: string): boolean {
  if (!originalName || typeof originalName !== 'string') return false;

  // Path traversal check
  if (originalName.includes('..') || originalName.includes('/') || originalName.includes('\\')) {
    return false;
  }

  const lowerName = originalName.toLowerCase();

  // Dangerous extension check (anywhere in filename, e.g. foo.php.png or avatar.jpg.exe)
  for (const dangerous of DANGEROUS_EXTENSIONS) {
    if (lowerName.includes(dangerous)) {
      return false;
    }
  }

  // Whitelisted terminal extension check
  const ext = path.extname(lowerName);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return false;
  }

  return true;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let subfolder = 'chat';
    if (req.baseUrl.includes('astrologer') || req.baseUrl.includes('kyc') || req.path.includes('doc')) {
      subfolder = 'documents';
    } else if (req.path.includes('avatar') || req.path.includes('profile')) {
      subfolder = 'avatars';
    } else if (req.baseUrl.includes('pooja')) {
      subfolder = 'pooja';
    }
    const targetDir = path.join(UPLOAD_DIR, subfolder);
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    // Generate secure random server-side filename (never rely on user input)
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = `${crypto.randomUUID()}${ext}`;
    cb(null, safeName);
  },
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // 1. Filename security checks
  if (!isSafeFilename(file.originalname)) {
    return cb(new Error('Prohibited or dangerous file extension detected'));
  }

  // 2. MIME type whitelist check
  if (!ALLOWED_MIME_TYPES.has(file.mimetype.toLowerCase())) {
    return cb(new Error('Unsupported or prohibited MIME type'));
  }

  cb(null, true);
};

/**
 * Validate actual file magic bytes against allowed binary signatures
 */
export async function validateFileMagicBytes(filePath: string): Promise<{ valid: boolean; detectedType?: string }> {
  let fileHandle;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await fileHandle.read(buffer, 0, 16, 0);
    if (bytesRead < 4) {
      return { valid: false };
    }

    // Check JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { valid: true, detectedType: 'image/jpeg' };
    }

    // Check PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { valid: true, detectedType: 'image/png' };
    }

    // Check PDF: %PDF- (25 50 44 46)
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return { valid: true, detectedType: 'application/pdf' };
    }

    // Check WebP: RIFF .... WEBP
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return { valid: true, detectedType: 'image/webp' };
    }

    return { valid: false };
  } catch {
    return { valid: false };
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

export const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB maximum
    files: 1,
  },
});

export class StorageService {
  static getFileUrl(subfolder: string, filename: string): string {
    const safeName = path.basename(filename);
    return `${BASE_URL}/uploads/${subfolder}/${safeName}`;
  }

  static async saveBase64File(subfolder: string, filename: string, base64Data: string): Promise<string> {
    const safeName = path.basename(filename);
    if (!isSafeFilename(safeName)) {
      throw new Error('Prohibited or dangerous file extension in base64 upload');
    }

    const folderPath = path.join(UPLOAD_DIR, subfolder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    const filePath = path.join(folderPath, safeName);
    const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    
    // Check size cap (5MB max for base64)
    if (buffer.length > 5 * 1024 * 1024) {
      throw new Error('Base64 file payload exceeds 5MB limit');
    }

    await fs.promises.writeFile(filePath, buffer);
    return `${BASE_URL}/uploads/${subfolder}/${safeName}`;
  }
}
