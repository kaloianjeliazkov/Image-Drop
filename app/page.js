'use client';

import { useState, useEffect, useRef } from 'react';
import { upload } from '@vercel/blob/client';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

// Permanent folders: always visible as tabs and upload targets, even when empty
const PERMANENT_FOLDERS = ['android', 'ios'];

export default function Home() {
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [currentFolder, setCurrentFolder] = useState('');
  const [folderInput, setFolderInput] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [toast, setToast] = useState('');

  // Image editor (text / arrows / rename)
  const [editingFile, setEditingFile] = useState(null);
  const [editName, setEditName] = useState('');
  const [annotations, setAnnotations] = useState([]);
  const [tempArrow, setTempArrow] = useState(null);
  const [editTool, setEditTool] = useState('text');
  const canvasRef = useRef(null);
  const editImageRef = useRef(null);
  const arrowStartRef = useRef(null);
  
  // Multi-select & Batch features
  const [selectedUrls, setSelectedUrls] = useState(new Set());
  const [isZipping, setIsZipping] = useState(false);
  const [zipProgress, setZipProgress] = useState('');
  
  // Settings & options
  const [showSettings, setShowSettings] = useState(false);
  const [customDirHandle, setCustomDirHandle] = useState(null);
  const [customDirName, setCustomDirName] = useState('');
  const [autoSaveDirect, setAutoSaveDirect] = useState(false);
  const [deleteAfterDownload, setDeleteAfterDownload] = useState(false);
  const [knownFolders, setKnownFolders] = useState([]);

  const fileInputRef = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  // Initialize from localStorage once on client
  useEffect(() => {
    const saved = localStorage.getItem('image_drop_last_folder');
    if (saved) {
      setCurrentFolder(saved);
      setFolderInput(saved);
    }
    const savedDeleteSetting = localStorage.getItem('image_drop_delete_after_download');
    if (savedDeleteSetting !== null) {
      setDeleteAfterDownload(savedDeleteSetting === 'true');
    }
    const savedKnownFolders = localStorage.getItem('image_drop_known_folders');
    if (savedKnownFolders) {
      try {
        const parsed = JSON.parse(savedKnownFolders);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setKnownFolders(parsed);
        }
      } catch (e) {}
    }
  }, []);

  const selectFolder = (name) => {
    if (!name) return;
    setCurrentFolder(name);
    // " edited" folders are output-only: viewing them does not change the upload target
    if (!name.endsWith(' edited')) {
      setFolderInput(name);
      localStorage.setItem('image_drop_last_folder', name);
    }
  };

  const loadFiles = async (forceFresh = false) => {
    setIsRefreshing(true);
    try {
      const res = await fetch(`/api/files${forceFresh ? '?fresh=1' : ''}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      const loaded = data.files || [];
      setFiles(loaded);

      // Extract unique folders from uploaded files
      const folderMap = {};
      loaded.forEach(f => {
        if (f.folder) {
          folderMap[f.folder] = (folderMap[f.folder] || 0) + 1;
        }
      });

      // Merge permanent + known folders + folders from files so android/ios always remain visible
      setKnownFolders(prev => {
        const combined = Array.from(new Set([...PERMANENT_FOLDERS, ...prev, ...Object.keys(folderMap)]));
        localStorage.setItem('image_drop_known_folders', JSON.stringify(combined));

        const folderList = combined.map(name => ({
          name,
          count: folderMap[name] || 0
        })).sort((a, b) => a.name.localeCompare(b.name));

        setFolders(folderList);

        // Auto select first available folder if none selected
        if (!currentFolder && folderList.length > 0) {
          const savedLast = localStorage.getItem('image_drop_last_folder');
          const toSelect = (savedLast && folderList.some(f => f.name === savedLast))
            ? savedLast
            : folderList[0].name;
          setCurrentFolder(toSelect);
          setFolderInput(toSelect);
        }

        return combined;
      });
    } catch (err) {
      console.error(err);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadFiles();
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

      // Auto delete if option enabled
      if (deleteAfterDownload) {
        const urlsToDelete = filesToDownload.map(f => f.url);
        await deleteFilesSilently(urlsToDelete);
      }
    } catch (err) {
      console.error(err);
      showToast(`❌ Error creating ZIP: ${err.message}`);
    }

    setIsZipping(false);
    setZipProgress('');
  };

  // Download files as separate individual files directly
  const downloadAsIndividualFiles = async (filesToDownload) => {
    if (filesToDownload.length === 0) return;
    setIsZipping(true);
    setZipProgress(`Downloading 0/${filesToDownload.length} files...`);

    let savedCount = 0;
    const downloadedUrls = [];
    for (let i = 0; i < filesToDownload.length; i++) {
      const file = filesToDownload[i];
      setZipProgress(`Downloading ${i + 1}/${filesToDownload.length}: ${file.name}...`);
      try {
        const resp = await fetch(file.url);
        const blob = await resp.blob();
        const savedDirect = await saveFileToDirectory(file.name, blob);
        if (!savedDirect) {
          saveAs(blob, file.name);
        }
        savedCount++;
        downloadedUrls.push(file.url);
        // Small delay between browser downloads if not using direct directory handle
        if (!customDirHandle) {
          await new Promise(r => setTimeout(r, 350));
        }
      } catch (e) {
        console.error(`Failed to download ${file.name}`, e);
      }
    }

    setIsZipping(false);
    setZipProgress('');
    showToast(`✓ Downloaded ${savedCount} file(s) individually!`);

    // Auto delete if option enabled
    if (deleteAfterDownload && downloadedUrls.length > 0) {
      await deleteFilesSilently(downloadedUrls);
    }
  };

  // Silently delete files from blob store (for auto-delete on download)
  const deleteFilesSilently = async (urls) => {
    try {
      await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      setSelectedUrls(new Set());
      loadFiles();
      showToast('🧹 Cleaned up downloaded files');
    } catch (e) {
      console.warn('Failed auto-delete cleanup:', e);
    }
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

  // Delete entire folder (all files inside + remove tab)
  const handleDeleteFolder = async (folderName, e) => {
    if (e) e.stopPropagation();
    if (PERMANENT_FOLDERS.includes(folderName)) return; // android/ios are permanent
    if (!confirm(`Delete folder "${folderName}" and all files inside?`)) return;

    try {
      const folderFiles = files.filter(f => f.folder === folderName);
      if (folderFiles.length > 0) {
        await fetch('/api/files', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: folderFiles.map(f => f.url) }),
        });
      }

      // Remove from known folders list in state & localStorage
      let updatedFolders = [];
      setKnownFolders(prev => {
        const remaining = prev.filter(name => name !== folderName);
        updatedFolders = remaining;
        localStorage.setItem('image_drop_known_folders', JSON.stringify(remaining));
        return remaining;
      });

      // If active folder was deleted, switch to another existing folder or blank
      if (currentFolder === folderName) {
        const nextFolder = updatedFolders[0] || '';
        setCurrentFolder(nextFolder);
        setFolderInput(nextFolder);
        if (nextFolder) {
          localStorage.setItem('image_drop_last_folder', nextFolder);
        } else {
          localStorage.removeItem('image_drop_last_folder');
        }
      }

      showToast(`Deleted folder "${folderName}"`);
      loadFiles();
    } catch (err) {
      showToast('Failed to delete folder');
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

  // ---- Image editor ----
  const openEditor = (file) => {
    setEditingFile(file);
    setEditName(file.name.substring(0, file.name.lastIndexOf('.')) || file.name);
    setAnnotations([]);
    setTempArrow(null);
    setEditTool('text');
  };

  const canvasPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height)
    };
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    const img = editImageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const drawOne = (a) => {
      if (a.type === 'text') {
        ctx.font = 'bold 32px sans-serif';
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = '#ffffff';
        ctx.strokeText(a.text, a.x, a.y);
        ctx.fillText(a.text, a.x, a.y);
      } else {
        ctx.strokeStyle = '#ff3b30';
        ctx.fillStyle = '#ff3b30';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x1, a.y1);
        ctx.lineTo(a.x2, a.y2);
        ctx.stroke();
        const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const head = 16;
        ctx.beginPath();
        ctx.moveTo(a.x2, a.y2);
        ctx.lineTo(a.x2 - head * Math.cos(angle - Math.PI / 6), a.y2 - head * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(a.x2 - head * Math.cos(angle + Math.PI / 6), a.y2 - head * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      }
    };
    annotations.forEach(drawOne);
    if (tempArrow) drawOne(tempArrow);
  };

  // Load the image once when the editor opens
  useEffect(() => {
    if (!editingFile) { editImageRef.current = null; return; }
    const img = new Image();
    // Request the image with CORS so the canvas stays untainted and can be exported (toBlob)
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      editImageRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const scale = Math.min(1, 1200 / img.width);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      redraw();
    };
    img.onerror = () => {
      showToast('❌ Could not load image for editing');
      setEditingFile(null);
    };
    img.src = editingFile.url;
  }, [editingFile]);

  // Redraw when annotations change
  useEffect(() => {
    if (editingFile) redraw();
  }, [annotations, tempArrow]);

  const onCanvasClick = (e) => {
    if (editTool !== 'text') return;
    const text = prompt('Text to add:');
    if (!text) return;
    const p = canvasPos(e);
    setAnnotations(prev => [...prev, { type: 'text', x: p.x, y: p.y, text }]);
  };

  const onCanvasMouseDown = (e) => {
    if (editTool !== 'arrow') return;
    arrowStartRef.current = canvasPos(e);
  };

  const onCanvasMouseMove = (e) => {
    if (editTool !== 'arrow' || !arrowStartRef.current) return;
    const p = canvasPos(e);
    setTempArrow({ x1: arrowStartRef.current.x, y1: arrowStartRef.current.y, x2: p.x, y2: p.y });
  };

  const onCanvasMouseUp = () => {
    if (tempArrow) {
      setAnnotations(prev => [...prev, { type: 'arrow', ...tempArrow }]);
      setTempArrow(null);
    }
    arrowStartRef.current = null;
  };

  const saveEditedImage = async () => {
    if (!editingFile || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ext = (editingFile.name.substring(editingFile.name.lastIndexOf('.')) || '.jpg').toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const base = (editName.trim() || editingFile.name).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const folder = `${editingFile.folder} edited`;
    const pathname = `${folder}/${base}_edited_${Date.now()}${ext === '.png' ? '.png' : '.jpg'}`;
    setIsUploading(true);
    setUploadStatus(`Saving edited image to "${folder}"...`);
    try {
      const blob = await new Promise(res => canvas.toBlob(res, mime, 0.92));
      if (!blob) throw new Error('Could not render image');
      await upload(pathname, blob, { access: 'public', handleUploadUrl: '/api/upload' });
      showToast(`✓ Saved to "${folder}"`);
      setEditingFile(null);
      setCurrentFolder(folder);
      loadFiles(true);
    } catch (err) {
      console.error('Edit save error:', err);
      showToast(`❌ Save failed: ${err.message || 'Upload failed'}`);
    } finally {
      setIsUploading(false);
      setUploadStatus('');
    }
  };

  return (
    <div>
      <style>{`@keyframes dropSpin { to { transform: rotate(360deg); } }`}</style>

      {/* Refresh loading indicator */}
      {isRefreshing && (
        <div style={{
          position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 500, display: 'flex', alignItems: 'center', gap: '8px',
          background: 'rgba(0,0,0,0.8)', padding: '7px 16px', borderRadius: '20px',
          color: '#fff', fontSize: '12px', fontWeight: 600, boxShadow: '0 4px 12px rgba(0,0,0,0.4)'
        }}>
          <span style={{
            display: 'inline-block', width: '12px', height: '12px',
            border: '2px solid rgba(255,255,255,0.25)', borderTopColor: '#6c63ff',
            borderRadius: '50%', animation: 'dropSpin 0.8s linear infinite'
          }} />
          Refreshing…
        </div>
      )}

      {/* Header */}
      <header style={{
        background: '#1a1a1a', borderBottom: '1px solid #333', padding: '16px 20px',
        position: 'sticky', top: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'space-between'
      }}>
        <h1
          onClick={loadFiles}
          title="Refresh"
          style={{ margin: 0, fontSize: '20px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}
        >
          <span>📸</span> Image Drop
        </h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button onClick={() => setShowSettings(true)} style={btnGhost} title="Settings & Download Location">
            ⚙️ Settings
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '20px' }}>
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
              <div
                key={f.name}
                onClick={() => selectFolder(f.name)}
                style={{
                  padding: '6px 14px', borderRadius: '20px', fontSize: '13px', cursor: 'pointer',
                  border: currentFolder === f.name ? '1px solid #6c63ff' : '1px solid #333',
                  background: currentFolder === f.name ? '#6c63ff' : '#1a1a1a',
                  color: currentFolder === f.name ? '#fff' : '#888',
                  display: 'flex', alignItems: 'center', gap: '8px',
                  userSelect: 'none'
                }}
              >
                <span>📁 {f.name}</span>
                <span style={{
                  background: 'rgba(255,255,255,0.2)', padding: '2px 7px', borderRadius: '10px', fontSize: '11px'
                }}>
                  {f.count}
                </span>
                {!PERMANENT_FOLDERS.includes(f.name) && (
                  <button
                    onClick={(e) => handleDeleteFolder(f.name, e)}
                    title={`Delete folder "${f.name}"`}
                    style={{
                      background: 'none', border: 'none', color: 'inherit',
                      opacity: 0.6, cursor: 'pointer', padding: '0 2px', fontSize: '14px',
                      lineHeight: 1
                    }}
                    onMouseEnter={(e) => e.target.style.opacity = '1'}
                    onMouseLeave={(e) => e.target.style.opacity = '0.6'}
                  >
                    ✕
                  </button>
                )}
              </div>
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

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {selectedUrls.size > 0 ? (
                <>
                  <button
                    onClick={() => downloadAsIndividualFiles(currentFolderFiles.filter(f => selectedUrls.has(f.url)))}
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
                <>
                  <button
                    onClick={() => downloadAsIndividualFiles(currentFolderFiles)}
                    disabled={isZipping}
                    style={btnPrimary}
                  >
                    ⬇ Download All Files ({currentFolderFiles.length})
                  </button>
                </>
              )}
              <button onClick={handleClearAll} style={btnDanger}>
                🗑 Clear All
              </button>
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
                      {!file.isVideo && (
                        <button
                          onClick={(e) => { e.stopPropagation(); openEditor(file); }}
                          style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '14px' }}
                          title="Edit image (add text, arrows, rename)"
                        >
                          ✏️
                        </button>
                      )}
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

              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={deleteAfterDownload}
                    onChange={(e) => {
                      const val = e.target.checked;
                      setDeleteAfterDownload(val);
                      localStorage.setItem('image_drop_delete_after_download', val.toString());
                      showToast(val ? 'Auto-delete after download enabled' : 'Auto-delete after download disabled');
                    }}
                    style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                  />
                  <span>
                    <strong>Auto-delete after download:</strong>
                    <div style={{ fontSize: '12px', color: '#888', marginTop: '2px' }}>
                      Automatically remove files from cloud storage once downloaded to keep storage clean.
                    </div>
                  </span>
                </label>
              </div>

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

          <div style={{ position: 'absolute', bottom: '20px', right: '20px', display: 'flex', gap: '8px' }}>
            {!currentFolderFiles[lightboxIndex].isVideo && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openEditor(currentFolderFiles[lightboxIndex]);
                }}
                style={{
                  padding: '8px 16px', background: 'rgba(255,255,255,0.15)', color: 'white',
                  borderRadius: '8px', border: 'none', fontWeight: 600, fontSize: '14px', cursor: 'pointer'
                }}
              >
                ✏️ Edit
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                downloadSingleFile(currentFolderFiles[lightboxIndex]);
              }}
              style={{
                padding: '8px 16px', background: '#6c63ff', color: 'white',
                borderRadius: '8px', border: 'none', fontWeight: 600, fontSize: '14px', cursor: 'pointer'
              }}
            >
              ⬇ Download
            </button>
          </div>
        </div>
      )}

      {/* Image Editor */}
      {editingFile && (
        <div
          onClick={() => setEditingFile(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 250,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1e1e1e', border: '1px solid #333', borderRadius: '14px',
              padding: '20px', maxWidth: '900px', width: '100%', color: '#e8e8e8',
              maxHeight: '95vh', overflowY: 'auto'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '17px' }}>✏️ Edit image</h3>
              <button onClick={() => setEditingFile(null)} style={{ background: 'none', border: 'none', color: '#888', fontSize: '20px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
              <button
                onClick={() => setEditTool('text')}
                style={editTool === 'text' ? btnPrimary : btnGhost}
                title="Click on the image to add text"
              >
                🅣 Add text
              </button>
              <button
                onClick={() => setEditTool('arrow')}
                style={editTool === 'arrow' ? btnPrimary : btnGhost}
                title="Drag on the image to draw an arrow"
              >
                ↗️ Add arrow
              </button>
              <span style={{ fontSize: '12px', color: '#888' }}>
                {editTool === 'text' ? 'Click the image to place text' : 'Drag on the image to draw an arrow'}
              </span>
            </div>

            <label style={{ fontSize: '13px', color: '#888', display: 'block', marginBottom: '6px' }}>File name</label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              style={{ width: '100%', background: '#252525', border: '1px solid #333', color: '#e8e8e8', padding: '8px 12px', borderRadius: '8px', fontSize: '14px', outline: 'none', marginBottom: '12px', boxSizing: 'border-box' }}
            />

            <canvas
              ref={canvasRef}
              onClick={onCanvasClick}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasMouseUp}
              style={{ display: 'block', maxWidth: '100%', borderRadius: '8px', cursor: editTool === 'text' ? 'text' : 'crosshair', background: '#000' }}
            />

            <div style={{ display: 'flex', gap: '8px', marginTop: '14px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button onClick={() => setEditingFile(null)} style={btnGhost}>Cancel</button>
              <button onClick={saveEditedImage} disabled={isUploading} style={btnPrimary}>
                💾 Save to "{editingFile.folder} edited"
              </button>
            </div>
          </div>
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
