'use client';

import { useState, useEffect, useRef } from 'react';
import { upload } from '@vercel/blob/client';

export default function Home() {
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [currentFolder, setCurrentFolder] = useState('general');
  const [folderInput, setFolderInput] = useState('general');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [toast, setToast] = useState('');
  const fileInputRef = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const loadFiles = async () => {
    try {
      const res = await fetch('/api/files');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      const loaded = data.files || [];
      setFiles(loaded);

      // Extract unique folders
      const folderMap = {};
      loaded.forEach(f => {
        const fold = f.folder || 'general';
        folderMap[fold] = (folderMap[fold] || 0) + 1;
      });
      const uniqueFolders = Object.keys(folderMap).map(name => ({
        name,
        count: folderMap[name]
      })).sort((a, b) => a.name.localeCompare(b.name));

      setFolders(uniqueFolders);
      if (uniqueFolders.length > 0 && !uniqueFolders.some(f => f.name === currentFolder)) {
        setCurrentFolder(uniqueFolders[0].name);
        setFolderInput(uniqueFolders[0].name);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadFiles();
    const timer = setInterval(loadFiles, 12000);
    return () => clearInterval(timer);
  }, [currentFolder]);

  const handleUpload = async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setIsUploading(true);
    setUploadProgress(0);

    const folder = (folderInput.trim() || 'general').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    const total = fileList.length;
    let successCount = 0;

    for (let i = 0; i < total; i++) {
      const file = fileList[i];
      const ext = file.name.substring(file.name.lastIndexOf('.')) || '.bin';
      const base = file.name.substring(0, file.name.lastIndexOf('.')).replace(/[^a-zA-Z0-9_-]/g, '_');
      const pathname = `${folder}/${base}_${Date.now()}${ext}`;

      setUploadStatus(`Uploading ${i + 1}/${total}: ${file.name}`);

      try {
        await upload(pathname, file, {
          access: 'public',
          handleUploadUrl: '/api/upload',
        });
        successCount++;
        setUploadProgress(Math.round(((i + 1) / total) * 100));
      } catch (err) {
        console.error('Upload error:', err);
        showToast(`❌ Error: ${err.message || 'Upload failed'}`);
      }
    }

    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (successCount > 0) {
      showToast(`✓ Uploaded ${successCount} file(s)!`);
      setCurrentFolder(folder);
      loadFiles();
    }
  };

  const handleDelete = async (url) => {
    if (!confirm('Delete this file?')) return;
    try {
      await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      showToast('Deleted file');
      loadFiles();
    } catch (err) {
      showToast('Delete failed');
    }
  };

  const handleClearAll = async () => {
    if (!confirm('Delete ALL files across all folders?')) return;
    try {
      const urls = files.map(f => f.url);
      await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      showToast('All files cleared');
      loadFiles();
    } catch (err) {
      showToast('Clear failed');
    }
  };

  const currentFolderFiles = files.filter(f => f.folder === currentFolder);

  return (
    <div>
      {/* Header */}
      <header style={{
        background: '#1a1a1a', borderBottom: '1px solid #333', padding: '16px 20px',
        position: 'sticky', top: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'space-between'
      }}>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>📸</span> Image Drop
        </h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={loadFiles} style={btnGhost}>↻ Refresh</button>
          <button onClick={handleClearAll} style={btnDanger}>🗑 Clear All</button>
        </div>
      </header>

      {/* Main Container */}
      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '20px' }}>
        {/* Folder Select */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '14px', color: '#888', fontWeight: 600 }}>📂 Target Folder:</label>
          <input
            type="text"
            value={folderInput}
            onChange={(e) => setFolderInput(e.target.value)}
            placeholder="general"
            style={{
              background: '#252525', border: '1px solid #333', color: '#e8e8e8',
              padding: '8px 12px', borderRadius: '8px', fontSize: '14px', outline: 'none'
            }}
          />
        </div>

        {/* Upload Drop Zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.length) handleUpload(e.dataTransfer.files);
          }}
          style={{
            border: '2px dashed #444', borderRadius: '12px', padding: '40px 20px',
            textAlign: 'center', cursor: 'pointer', marginBottom: '24px', background: '#1a1a1a'
          }}
        >
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>☁️</div>
          <h3 style={{ margin: 0, fontSize: '18px' }}>Tap to select photos/videos or drag & drop</h3>
          <p style={{ margin: '8px 0 0', color: '#888', fontSize: '14px' }}>
            Supports photos and screen recordings (MP4, MOV, WebM) • Up to 250MB
          </p>
          <input
            type="file"
            ref={fileInputRef}
            onChange={(e) => {
              if (e.target.files?.length) handleUpload(e.target.files);
            }}
            accept="image/*,video/*"
            multiple
            style={{ display: 'none' }}
          />
        </div>

        {/* Progress Bar */}
        {isUploading && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{ height: '6px', background: '#252525', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ height: '100%', background: '#6c63ff', width: `${uploadProgress}%`, transition: 'width 0.2s' }}></div>
            </div>
            <div style={{ fontSize: '12px', color: '#888', marginTop: '6px', textAlign: 'center' }}>
              {uploadStatus} ({uploadProgress}%)
            </div>
          </div>
        )}

        {/* Folder Tabs */}
        {folders.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
            {folders.map(f => (
              <button
                key={f.name}
                onClick={() => {
                  setCurrentFolder(f.name);
                  setFolderInput(f.name);
                }}
                style={{
                  padding: '8px 16px', borderRadius: '20px', fontSize: '13px', cursor: 'pointer',
                  border: currentFolder === f.name ? '1px solid #6c63ff' : '1px solid #333',
                  background: currentFolder === f.name ? '#6c63ff' : '#1a1a1a',
                  color: currentFolder === f.name ? '#fff' : '#888',
                  display: 'flex', alignItems: 'center', gap: '6px'
                }}
              >
                📁 {f.name}
                <span style={{
                  background: 'rgba(255,255,255,0.2)', padding: '2px 7px', borderRadius: '10px', fontSize: '11px'
                }}>
                  {f.count}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Media Grid */}
        {currentFolderFiles.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#888' }}>
            <div style={{ fontSize: '64px', marginBottom: '16px' }}>📭</div>
            <h3 style={{ margin: 0, color: '#e8e8e8' }}>No files in this folder</h3>
            <p style={{ margin: '8px 0 0' }}>Upload images or videos from your phone to view them here</p>
          </div>
        ) : (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px'
          }}>
            {currentFolderFiles.map((file, idx) => (
              <div key={file.url} style={{
                background: '#1a1a1a', border: '1px solid #333', borderRadius: '12px',
                overflow: 'hidden', position: 'relative'
              }}>
                {file.isVideo ? (
                  <div style={{ position: 'relative', width: '100%', aspectRatio: '1', cursor: 'pointer' }} onClick={() => setLightboxIndex(idx)}>
                    <video src={file.url} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <div style={{
                      position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                      background: 'rgba(0,0,0,0.6)', color: 'white', borderRadius: '50%', width: '44px',
                      height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px'
                    }}>
                      ▶
                    </div>
                  </div>
                ) : (
                  <img
                    src={file.url}
                    alt={file.name}
                    loading="lazy"
                    onClick={() => setLightboxIndex(idx)}
                    style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', cursor: 'pointer', display: 'block' }}
                  />
                )}
                <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '12px', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '130px' }} title={file.name}>
                    {file.name}
                  </span>
                  <button onClick={() => handleDelete(file.url)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '16px' }} title="Delete">
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Lightbox */}
      {lightboxIndex !== null && currentFolderFiles[lightboxIndex] && (
        <div
          onClick={() => setLightboxIndex(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
          }}
        >
          <button
            onClick={() => setLightboxIndex(null)}
            style={{
              position: 'absolute', top: '20px', right: '20px', fontSize: '32px', color: 'white',
              background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
              width: '44px', height: '44px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
          >
            ✕
          </button>

          {currentFolderFiles[lightboxIndex].isVideo ? (
            <video
              src={currentFolderFiles[lightboxIndex].url}
              controls
              autoPlay
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '90vw', maxHeight: '85vh', borderRadius: '8px' }}
            />
          ) : (
            <img
              src={currentFolderFiles[lightboxIndex].url}
              alt=""
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: '8px' }}
            />
          )}

          <a
            href={currentFolderFiles[lightboxIndex].downloadUrl || currentFolderFiles[lightboxIndex].url}
            download
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', bottom: '20px', right: '20px', padding: '8px 16px',
              background: '#6c63ff', color: 'white', borderRadius: '8px', textDecoration: 'none',
              fontWeight: 600, fontSize: '14px'
            }}
          >
            ⬇ Download
          </a>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          background: '#4caf50', color: 'white', padding: '12px 24px', borderRadius: '8px',
          fontSize: '14px', fontWeight: 600, zIndex: 300, boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

const btnGhost = {
  background: 'transparent', color: '#888', border: '1px solid #333',
  padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer'
};

const btnDanger = {
  background: '#e84057', color: 'white', border: 'none',
  padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer'
};
