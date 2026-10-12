'use client';

import { useState, useEffect, useRef } from 'react';
import { upload } from '@vercel/blob/client';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

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
  
  // Multi-select & Batch features
  const [selectedUrls, setSelectedUrls] = useState(new Set());
  const [isZipping, setIsZipping] = useState(false);
  const [zipProgress, setZipProgress] = useState('');
  
  // Settings Modal & Directory Handle (File System Access API)
  const [showSettings, setShowSettings] = useState(false);
  const [customDirHandle, setCustomDirHandle] = useState(null);
  const [customDirName, setCustomDirName] = useState('');
  const [autoSaveDirect, setAutoSaveDirect] = useState(false);

  const fileInputRef = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
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

  // Clear selections when switching folder
  useEffect(() => {
    setSelectedUrls(new Set());
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

  // Toggle select single item
  const toggleSelect = (url) => {
    const updated = new Set(selectedUrls);
    if (updated.has(url)) {
      updated.delete(url);
    } else {
      updated.add(url);
    }
    setSelectedUrls(updated);
  };

  const currentFolderFiles = files.filter(f => f.folder === currentFolder);

  // Select / Deselect all in current folder
  const handleSelectAll = () => {
    if (selectedUrls.size === currentFolderFiles.length) {
      setSelectedUrls(new Set());
    } else {
      setSelectedUrls(new Set(currentFolderFiles.map(f => f.url)));
    }
  };

  // Direct save to custom folder if File System Access API is supported and configured
  const saveFileToDirectory = async (filename, blob) => {
    if (customDirHandle && autoSaveDirect) {
      try {
        const fileHandle = await customDirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch (err) {
        console.warn('Failed direct directory write:', err);
      }
    }
    return false;
  };

  // Download a single file
  const downloadSingleFile = async (file) => {
    try {
      showToast(`Downloading ${file.name}...`);
      const response = await fetch(file.url);
      const blob = await response.blob();
      
      const savedDirect = await saveFileToDirectory(file.name, blob);
      if (savedDirect) {
        showToast(`Saved to ${customDirName}!`);
      } else {
        saveAs(blob, file.name);
      }
    } catch (err) {
      showToast(`Download failed: ${err.message}`);
    }
  };

  // Download files (either selected or entire folder) as a ZIP archive
  const downloadAsZip = async (filesToDownload, zipName) => {
    if (filesToDownload.length === 0) return;
    setIsZipping(true);
    setZipProgress(`Preparing 0/${filesToDownload.length}...`);

    try {
      const zip = new JSZip();
      let completed = 0;

      for (const item of filesToDownload) {
        try {
          const resp = await fetch(item.url);
          const blob = await resp.blob();
          zip.file(item.name, blob);
        } catch (e) {
          console.error(`Failed to fetch ${item.name}`, e);
        }
        completed++;
        setZipProgress(`Downloading ${completed}/${filesToDownload.length}...`);
      }

      setZipProgress('Generating ZIP package...');
      const zipContent = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        setZipProgress(`Zipping... ${Math.round(metadata.percent)}%`);
      });

      const finalName = `${zipName}.zip`;
      const savedDirect = await saveFileToDirectory(finalName, zipContent);
      if (savedDirect) {
        showToast(`✓ ZIP saved to ${customDirName}!`);
      } else {
        saveAs(zipContent, finalName);
        showToast(`✓ Downloaded ${finalName}`);
      }
    } catch (err) {
      console.error(err);
      showToast(`❌ Error creating ZIP: ${err.message}`);
    }

    setIsZipping(false);
    setZipProgress('');
  };

  // Delete selected files
  const handleDeleteSelected = async () => {
    if (selectedUrls.size === 0) return;
    if (!confirm(`Delete ${selectedUrls.size} selected file(s)?`)) return;

    try {
      await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: Array.from(selectedUrls) }),
      });
      showToast(`Deleted ${selectedUrls.size} files`);
      setSelectedUrls(new Set());
      loadFiles();
    } catch (err) {
      showToast('Delete failed');
    }
  };

  // Delete single file
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
      setSelectedUrls(new Set());
      loadFiles();
    } catch (err) {
      showToast('Clear failed');
    }
  };

  // Pick default download folder via File System Access API
  const handlePickDirectory = async () => {
    if (!window.showDirectoryPicker) {
      alert("Your browser does not support picking default folders directly. To configure where downloads go, set your browser's default download folder in Chrome/Edge/Brave/Safari Settings -> Downloads.");
      return;
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setCustomDirHandle(dirHandle);
      setCustomDirName(dirHandle.name);
      setAutoSaveDirect(true);
      showToast(`✓ Set download folder: ${dirHandle.name}`);
    } catch (err) {
      console.warn('Folder selection aborted or denied', err);
    }
  };

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
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button onClick={() => setShowSettings(true)} style={btnGhost} title="Settings & Download Location">
            ⚙️ Settings
          </button>
          <button onClick={loadFiles} style={btnGhost}>↻ Refresh</button>
          <button onClick={handleClearAll} style={btnDanger}>🗑 Clear All</button>
        </div>
      </header>

      {/* Main Container */}
      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '20px' }}>
        {/* Target Folder Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '14px', color: '#888', fontWeight: 600 }}>📂 Target Upload Folder:</label>
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
            border: '2px dashed #444', borderRadius: '12px', padding: '36px 20px',
            textAlign: 'center', cursor: 'pointer', marginBottom: '20px', background: '#1a1a1a'
          }}
        >
          <div style={{ fontSize: '42px', marginBottom: '8px' }}>☁️</div>
          <h3 style={{ margin: 0, fontSize: '18px' }}>Tap to select photos/videos or drag & drop</h3>
          <p style={{ margin: '8px 0 0', color: '#888', fontSize: '14px' }}>
            Supports photos & screen recordings (MP4, MOV, WebM, etc.) • Up to 250MB
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

        {/* Progress Bar for Upload */}
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
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
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

        {/* Folder Actions Toolbar (Download Folder, Select All, Batch Actions) */}
        {currentFolderFiles.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: '#161616', border: '1px solid #282828', borderRadius: '10px',
            padding: '10px 14px', marginBottom: '16px', flexWrap: 'wrap', gap: '10px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button onClick={handleSelectAll} style={btnGhost}>
                {selectedUrls.size === currentFolderFiles.length ? '☑ Deselect All' : '☐ Select All'}
              </button>
              <span style={{ fontSize: '13px', color: '#888' }}>
                {selectedUrls.size > 0 ? `${selectedUrls.size} of ${currentFolderFiles.length} selected` : `${currentFolderFiles.length} item(s)`}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {selectedUrls.size > 0 ? (
                <>
                  <button
                    onClick={() => downloadAsZip(currentFolderFiles.filter(f => selectedUrls.has(f.url)), `${currentFolder}_selected`)}
                    disabled={isZipping}
                    style={btnPrimary}
                  >
                    ⬇ Download Selected ({selectedUrls.size})
                  </button>
                  <button onClick={handleDeleteSelected} style={btnDanger}>
                    🗑 Delete Selected
                  </button>
                </>
              ) : (
                <button
                  onClick={() => downloadAsZip(currentFolderFiles, currentFolder)}
                  disabled={isZipping}
                  style={btnPrimary}
                >
                  📦 Download Folder ({currentFolder}) as ZIP
                </button>
              )}
            </div>
          </div>
        )}

        {/* ZIP Download Progress */}
        {isZipping && (
          <div style={{
            background: '#25203f', border: '1px solid #6c63ff', borderRadius: '8px',
            padding: '12px', marginBottom: '16px', textAlign: 'center', fontSize: '13px', color: '#e8e8e8'
          }}>
            ⏳ {zipProgress}
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
            {currentFolderFiles.map((file, idx) => {
              const isSelected = selectedUrls.has(file.url);
              return (
                <div
                  key={file.url}
                  style={{
                    background: '#1a1a1a',
                    border: isSelected ? '2px solid #6c63ff' : '1px solid #333',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    position: 'relative',
                    transition: 'border-color 0.15s'
                  }}
                >
                  {/* Select Checkbox in Corner */}
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSelect(file.url);
                    }}
                    style={{
                      position: 'absolute', top: '8px', left: '8px', zIndex: 10,
                      background: isSelected ? '#6c63ff' : 'rgba(0,0,0,0.6)',
                      color: 'white', borderRadius: '6px', width: '26px', height: '26px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', border: '1px solid rgba(255,255,255,0.4)',
                      fontSize: '14px', fontWeight: 'bold'
                    }}
                  >
                    {isSelected ? '✓' : ''}
                  </div>

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
                    <span style={{ fontSize: '12px', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '110px' }} title={file.name}>
                      {file.name}
                    </span>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <button
                        onClick={() => downloadSingleFile(file)}
                        style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '14px' }}
                        title="Download file"
                      >
                        ⬇
                      </button>
                      <button
                        onClick={() => handleDelete(file.url)}
                        style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '15px' }}
                        title="Delete file"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <div
          onClick={() => setShowSettings(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 300,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1e1e1e', border: '1px solid #333', borderRadius: '14px',
              padding: '24px', maxWidth: '480px', width: '100%', color: '#e8e8e8'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '18px' }}>⚙️ Download & Save Settings</h3>
              <button onClick={() => setShowSettings(false)} style={{ background: 'none', border: 'none', color: '#888', fontSize: '20px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ fontSize: '14px', color: '#bbb', lineHeight: '1.5', marginBottom: '20px' }}>
              <p style={{ marginTop: 0 }}>
                <strong>Direct Laptop Folder:</strong> You can select a dedicated folder on your laptop (e.g. <code>Downloads/ImageDrop</code>) where downloaded files and ZIP packages will be saved directly.
              </p>

              {customDirName ? (
                <div style={{ background: '#252525', padding: '12px', borderRadius: '8px', marginBottom: '12px' }}>
                  <div style={{ color: '#4caf50', fontWeight: 600 }}>✓ Direct Folder Selected:</div>
                  <div style={{ fontSize: '13px', marginTop: '4px', wordBreak: 'break-all' }}>📁 {customDirName}</div>
                </div>
              ) : (
                <div style={{ background: '#252525', padding: '12px', borderRadius: '8px', marginBottom: '12px', color: '#888' }}>
                  No dedicated folder chosen yet. Files go to your standard browser Downloads.
                </div>
              )}

              <button onClick={handlePickDirectory} style={btnPrimary}>
                📁 {customDirName ? 'Change Folder' : 'Choose Download Folder'}
              </button>

              <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '20px 0' }} />

              <p style={{ fontSize: '13px', color: '#777', margin: 0 }}>
                💡 <em>Tip for Mobile:</em> On iOS and Android, downloads automatically save to your device's Files app or default Downloads folder.
              </p>
            </div>

            <button onClick={() => setShowSettings(false)} style={{ ...btnGhost, width: '100%', padding: '10px' }}>
              Done
            </button>
          </div>
        </div>
      )}

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

          <button
            onClick={(e) => {
              e.stopPropagation();
              downloadSingleFile(currentFolderFiles[lightboxIndex]);
            }}
            style={{
              position: 'absolute', bottom: '20px', right: '20px', padding: '8px 16px',
              background: '#6c63ff', color: 'white', borderRadius: '8px', border: 'none',
              fontWeight: 600, fontSize: '14px', cursor: 'pointer'
            }}
          >
            ⬇ Download
          </button>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          background: '#4caf50', color: 'white', padding: '12px 24px', borderRadius: '8px',
          fontSize: '14px', fontWeight: 600, zIndex: 400, boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
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

const btnPrimary = {
  background: '#6c63ff', color: 'white', border: 'none',
  padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer'
};

const btnDanger = {
  background: '#e84057', color: 'white', border: 'none',
  padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer'
};
