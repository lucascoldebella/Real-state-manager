'use client';

import React, { useCallback, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import styles from './UploadField.module.css';

export interface UploadFile {
  name: string;
  mime: string;
  data_b64: string;
  previewUrl: string;
  isVideo: boolean;
}

const MAGIC_JPEG = [0xFF, 0xD8, 0xFF];
const MAGIC_PNG  = [0x89, 0x50, 0x4E, 0x47];
const MAX_SIZE_MB = 15;

async function checkMagic(file: File): Promise<boolean> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf.slice(0, 12));
  if (bytes.length < 4) return false;
  if (MAGIC_JPEG.every((b, i) => bytes[i] === b)) return true;
  if (MAGIC_PNG.every((b, i) => bytes[i] === b)) return true;
  if (buf.byteLength >= 12) {
    const isRIFF = [82,73,70,70].every((b, i) => bytes[i] === b);
    const isWEBP = [87,69,66,80].every((b, i) => bytes[i+8] === b);
    if (isRIFF && isWEBP) return true;
  }
  if (buf.byteLength >= 8) {
    const b4 = [bytes[4],bytes[5],bytes[6],bytes[7]];
    if (b4.map(b => String.fromCharCode(b)).join('') === 'ftyp') return true;
  }
  return false;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface Props {
  files: UploadFile[];
  onChange: (files: UploadFile[]) => void;
  max?: number;
  requireImage?: boolean;
  label?: string;
  sublabel?: string;
}

export default function UploadField({
  files,
  onChange,
  max = 4,
  label = 'Toque para adicionar fotos ou vídeos',
  sublabel = 'JPEG, PNG, WEBP ou MP4 — máx. 15 MB cada',
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  const handleFiles = useCallback(async (selected: FileList | null) => {
    if (!selected) return;
    setError('');
    const newFiles: UploadFile[] = [];
    for (const file of Array.from(selected)) {
      if (files.length + newFiles.length >= max) { setError(`Máximo ${max} arquivos.`); break; }
      if (file.size > MAX_SIZE_MB * 1024 * 1024) { setError(`"${file.name}" excede ${MAX_SIZE_MB} MB.`); continue; }
      const ok = await checkMagic(file);
      if (!ok) { setError(`"${file.name}" não é um arquivo suportado.`); continue; }
      const data_b64 = await fileToBase64(file);
      const previewUrl = URL.createObjectURL(file);
      const isVideo = file.type.startsWith('video/');
      newFiles.push({ name: file.name, mime: file.type, data_b64, previewUrl, isVideo });
    }
    if (newFiles.length) onChange([...files, ...newFiles]);
  }, [files, max, onChange]);

  const remove = (idx: number) => {
    const next = [...files];
    URL.revokeObjectURL(next[idx].previewUrl);
    next.splice(idx, 1);
    onChange(next);
    setError('');
  };

  return (
    <div>
      {files.length < max && (
        <div className={styles.zone}>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4"
            capture="environment"
            multiple
            className={styles.zoneInput}
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Camera size={32} className={styles.zoneIcon} />
          <span className={styles.zoneLabel}>{label}</span>
          <span className={styles.zoneSub}>{sublabel}</span>
        </div>
      )}
      {files.length > 0 && (
        <div className={styles.grid}>
          {files.map((f, i) => (
            <div key={i} className={styles.thumb}>
              {f.isVideo
                ? <video className={styles.thumbVideo} src={f.previewUrl} muted playsInline />
                : <img className={styles.thumbImg} src={f.previewUrl} alt={f.name} />
              }
              <button type="button" className={styles.thumbRemove} onClick={() => remove(i)}><X size={12} /></button>
              <span className={styles.thumbName}>{f.name}</span>
            </div>
          ))}
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
      <p className={styles.count}>{files.length} / {max}</p>
    </div>
  );
}
