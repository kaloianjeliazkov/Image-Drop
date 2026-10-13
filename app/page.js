'use client';

import { useState, useEffect, useRef } from 'react';
import { upload } from '@vercel/blob/client';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

// Permanent folders: always visible as tabs and upload targets, even when empty.
// These four can never be deleted, with android/ios pinned to the left.
const PERMANENT_FOLDERS = ['android', 'ios', 'android edited', 'ios edited'];

// Biggest canvas iOS Safari can export (4096 x 4096 worth of pixels); larger photos are scaled down to this when saving edits
const MAX_EXPORT_PIXELS = 4096 * 4096;

// The editor canvas keeps (near) full resolution and is scaled down with CSS, so it looks as
// sharp and as large as the lightbox. Capped on the long side so huge photos stay quick to redraw.
const MAX_EDIT_DIM = 3000;

// Annotation sizes (font, stroke, arrow head) are authored against a ~1000px canvas and scaled
// with the real resolution, so they look the same on screen and in the full-resolution export.
const annK = (w, h) => Math.max(0.6, Math.min(6, Math.sqrt(w * h) / 1000));

// Where an edit is saved: "android" -> "android edited", and an already-edited folder stays put
// ("android edited" -> "android edited") instead of becoming "android edited edited".
const editedFolderFor = (folder) => `${String(folder || 'general').replace(/\s+edited$/i, '')} edited`;

// Folders like "android edited edited" came from an old bug and should never be shown or kept
const isStrayEditFolder = (name) => /(?:\s+edited){2,}$/i.test(String(name || ''));

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
  const [editTool, setEditTool] = useState('arrow');
  const [arrowColor, setArrowColor] = useState('#ff3b30'); // arrows: red (default) or green
  const [textDraft, setTextDraft] = useState(null);
  const [hoverAnn, setHoverAnn] = useState(false);
  const canvasRef = useRef(null);
  const editImageRef = useRef(null);
  const arrowRef = useRef(null);
  const dragAnnRef = useRef(null);
  // Undo / redo history for annotations
  const annotationsRef = useRef([]);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  
  // Multi-select & Batch features
  const [selectedUrls, setSelectedUrls] = useState(new Set());
  const [isZipping, setIsZipping] = useState(false);
  const [zipProgress, setZipProgress] = useState('');
  
  // Settings & options
  const [showSettings, setShowSettings] = useState(false);
  const [customDirHandle, setCustomDirHandle] = useState(null);
  const [customDirName, setCustomDirName] = useState('');
  const [autoSaveDirect, setAutoSaveDirect] = useState(false);
  // Mirrors customDirHandle so a folder picked mid-call is usable right away (state lags a render)
  const customDirHandleRef = useRef(null);
  const [deleteAfterDownload, setDeleteAfterDownload] = useState(false);
  const [knownFolders, setKnownFolders] = useState([]);

  const fileInputRef = useRef(null);
  const lastChangeRef = useRef(0);
  const loadSeqRef = useRef(0);

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
        if (Array.isArray(parsed)) {
          // Drop leftover "android edited edited" style folders from an old bug
          const cleaned = parsed.filter(name => !isStrayEditFolder(name));
          if (cleaned.length > 0) setKnownFolders(cleaned);
          if (cleaned.length !== parsed.length) {
            localStorage.setItem('image_drop_known_folders', JSON.stringify(cleaned));
          }
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
    // The API caches the list for 20s, so skip that cache for a while after we changed files
    const fresh = forceFresh || Date.now() - lastChangeRef.current < 20000;
    const seq = ++loadSeqRef.current;
    setIsRefreshing(true);
    try {
      const res = await fetch(`/api/files${fresh ? '?fresh=1' : ''}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      // A newer refresh started meanwhile (e.g. the folder switch after an upload); let that one win
      if (seq !== loadSeqRef.current) return;
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
        const combined = Array.from(new Set([...PERMANENT_FOLDERS, ...prev, ...Object.keys(folderMap)]))
          // Hide stray "… edited edited" folders, but keep them while they still hold files
          .filter(name => !isStrayEditFolder(name) || (folderMap[name] || 0) > 0);
        localStorage.setItem('image_drop_known_folders', JSON.stringify(combined));

        const folderList = combined.map(name => ({
          name,
          count: folderMap[name] || 0
        })).sort((a, b) => {
          // Permanent folders (android, ios) always first, then the rest alphabetically
          const aPerm = PERMANENT_FOLDERS.indexOf(a.name);
          const bPerm = PERMANENT_FOLDERS.indexOf(b.name);
          if (aPerm !== -1 || bPerm !== -1) {
            if (aPerm === -1) return 1;
            if (bPerm === -1) return -1;
            return aPerm - bPerm;
          }
          return a.name.localeCompare(b.name);
        });

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
      if (seq === loadSeqRef.current) setIsRefreshing(false);
    }
  };

  // Reload after uploading or deleting, bypassing the server's (now stale) list cache
  const refreshAfterChange = () => {
    lastChangeRef.current = Date.now();
    loadFiles(true);
  };

  // Record a finished upload in the Supabase index. Server-side no-op until Supabase env vars
  // are configured, and never allowed to fail an upload that otherwise succeeded.
  const indexFile = async (blob, size) => {
    if (!blob || !blob.url) return;
    try {
      await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pathname: blob.pathname,
          url: blob.url,
          downloadUrl: blob.downloadUrl,
          size: size ?? 0,
        }),
      });
    } catch (err) {
      console.warn('Index update failed:', err);
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

    // Files keep their real name (no timestamp). If a name is already used in the target folder,
    // _2, _3, ... is appended (same rule as edited images), so nothing is silently overwritten.
    const usedInBatch = new Set();
    for (let i = 0; i < total; i++) {
      const file = fileList[i];
      const ext = file.name.substring(file.name.lastIndexOf('.')) || '.bin';
      const base = file.name.substring(0, file.name.lastIndexOf('.')).replace(/[^a-zA-Z0-9_-]/g, '_') || 'file';
      const taken = new Set([
        ...files.filter(f => f.folder === folder).map(f => f.name.toLowerCase()),
        ...usedInBatch,
      ]);
      let filename = `${base}${ext}`;
      for (let n = 2; taken.has(filename.toLowerCase()); n++) {
        filename = `${base}_${n}${ext}`;
      }
      usedInBatch.add(filename.toLowerCase());
      const pathname = `${folder}/${filename}`;

      setUploadStatus(`Uploading ${i + 1}/${total}: ${file.name}`);

      try {
        const uploaded = await upload(pathname, file, {
          access: 'public',
          handleUploadUrl: '/api/upload',
        });
        await indexFile(uploaded, file.size);
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
      refreshAfterChange();
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
    if (customDirHandleRef.current) {
      try {
        const fileHandle = await customDirHandleRef.current.getFileHandle(filename, { create: true });
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

  // Download/save the given files: single destination folder, no per-file prompts.
  const downloadAsIndividualFiles = async (filesToDownload) => {
    if (filesToDownload.length === 0) return;

    // Several files and no destination folder set yet: ask ONCE for a folder, then write every
    // file straight into it (instead of a separate browser save prompt per file).
    if (filesToDownload.length > 1 && !customDirHandleRef.current) {
      if (window.showDirectoryPicker) {
        try {
          const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
          customDirHandleRef.current = dirHandle;
          folderLabel = dirHandle.name;
          setCustomDirHandle(dirHandle);
          setCustomDirName(dirHandle.name);
          setAutoSaveDirect(true);
          showToast(`Saving ${filesToDownload.length} file(s) to ${dirHandle.name}...`);
        } catch (err) {
          showToast('Download cancelled');
          return; // user closed the folder picker
        }
      }
    }

    setIsZipping(true);
    setZipProgress(`Saving 0/${filesToDownload.length} files...`);

    let savedCount = 0;
    const downloadedUrls = [];
    let folderLabel = customDirName;
    for (let i = 0; i < filesToDownload.length; i++) {
      const file = filesToDownload[i];
      setZipProgress(`Saving ${i + 1}/${filesToDownload.length}: ${file.name}...`);
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
        if (!customDirHandleRef.current) {
          await new Promise(r => setTimeout(r, 350));
        }
      } catch (e) {
        console.error(`Failed to download ${file.name}`, e);
      }
    }

    setIsZipping(false);
    setZipProgress('');
    showToast(customDirHandleRef.current
      ? `✓ Saved ${savedCount} file(s) to ${folderLabel}!`
      : `✓ Downloaded ${savedCount} file(s) individually!`);

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
      refreshAfterChange();
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
      refreshAfterChange();
    } catch (err) {
      showToast('Delete failed');
    }
  };

  // Delete single file. Returns true when it was actually deleted (used by the lightbox).
  const handleDelete = async (url) => {
    if (!confirm('Delete this file?')) return false;
    try {
      await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      showToast('Deleted file');
      refreshAfterChange();
      return true;
    } catch (err) {
      showToast('Delete failed');
      return false;
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
      refreshAfterChange();
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
      refreshAfterChange();
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
      customDirHandleRef.current = dirHandle;
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
    annotationsRef.current = [];
    undoStackRef.current = [];
    redoStackRef.current = [];
    setTempArrow(null);
    setTextDraft(null);
    setHoverAnn(false);
    setEditTool('arrow');
  };

  // Pointer position in canvas pixels, clamped to the image so drags can't leave it
  const canvasPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clamp = (v, max) => Math.max(0, Math.min(max, v));
    return {
      x: clamp((e.clientX - rect.left) * (canvas.width / rect.width), canvas.width),
      y: clamp((e.clientY - rect.top) * (canvas.height / rect.height), canvas.height)
    };
  };

  // Paint the image and annotations onto a canvas of any size. Annotations are stored in
  // editor-canvas coordinates, so they get scaled up when saving at the original resolution
  const paintEdit = (target, list) => {
    const view = canvasRef.current;
    const ctx = target.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(editImageRef.current, 0, 0, target.width, target.height);
    ctx.setTransform(target.width / view.width, 0, 0, target.height / view.height, 0, 0);
    const k = annK(view.width, view.height);
    const drawOne = (a) => {
      if (a.type === 'text') {
        ctx.font = `bold ${32 * k}px sans-serif`;
        ctx.textBaseline = 'middle'; // (x, y) is the left middle of the text, where the text field sat
        ctx.lineWidth = 6 * k;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = '#ffffff';
        ctx.strokeText(a.text, a.x, a.y);
        ctx.fillText(a.text, a.x, a.y);
      } else {
        const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const head = 22 * k;
        const spread = Math.PI / 7;
        // End the shaft inside the head so its round cap doesn't blunt the tip
        const shaftX = a.x2 - head * 0.8 * Math.cos(angle);
        const shaftY = a.y2 - head * 0.8 * Math.sin(angle);
        const drawArrow = (color, outline) => {
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = 5 * k + outline;
          ctx.beginPath();
          ctx.moveTo(a.x1, a.y1);
          ctx.lineTo(shaftX, shaftY);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(a.x2, a.y2);
          ctx.lineTo(a.x2 - head * Math.cos(angle - spread), a.y2 - head * Math.sin(angle - spread));
          ctx.lineTo(a.x2 - head * Math.cos(angle + spread), a.y2 - head * Math.sin(angle + spread));
          ctx.closePath();
          ctx.fill();
          if (outline) {
            ctx.lineWidth = outline;
            ctx.stroke();
          }
        };
        // Dark edge first (like the text outline) so the arrow shows up on red or busy screenshots
        drawArrow('rgba(0,0,0,0.55)', 3 * k);
        drawArrow(a.color || '#ff3b30', 0);
      }
    };
    list.forEach(drawOne);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !editImageRef.current) return;
    paintEdit(canvas, tempArrow ? [...annotations, tempArrow] : annotations);
  };

  // ---- Undo / redo history ----
  const snapshot = (list) => JSON.parse(JSON.stringify(list || []));
  const pushUndo = () => {
    undoStackRef.current.push(snapshot(annotationsRef.current));
    redoStackRef.current = [];
  };
  const undo = () => {
    if (undoStackRef.current.length === 0) return;
    redoStackRef.current.push(snapshot(annotationsRef.current));
    setTextDraft(null);
    setAnnotations(undoStackRef.current.pop());
  };
  const redo = () => {
    if (redoStackRef.current.length === 0) return;
    undoStackRef.current.push(snapshot(annotationsRef.current));
    setTextDraft(null);
    setAnnotations(redoStackRef.current.pop());
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
      // Keep (near) full resolution and let CSS fit it to the screen — that way the editor is
      // as large and as sharp as the lightbox, and the saved edit stays high quality
      const scale = Math.min(1, MAX_EDIT_DIM / Math.max(img.width, img.height));
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

  // Keep a ref of the annotations in sync (used by undo/redo)
  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  // Undo (Ctrl+Z) / Redo (Ctrl+Y or Ctrl+Shift+Z) while editing
  useEffect(() => {
    if (!editingFile) return;
    const onKeyDown = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // let inputs handle their own undo
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = (e.key || '').toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingFile]);

  const distToSegment = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
  };

  // Find the topmost annotation (text or arrow) under point p
  const findAnnotationAt = (p) => {
    const canvas = canvasRef.current;
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    const k = annK(canvas.width, canvas.height);
    ctx.font = `bold ${32 * k}px sans-serif`;
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i];
      if (a.type === 'arrow') {
        if (distToSegment(p, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) <= 12 * k) return i;
      } else {
        const w = ctx.measureText(a.text).width;
        if (p.x >= a.x - 10 * k && p.x <= a.x + w + 10 * k && p.y >= a.y - 22 * k && p.y <= a.y + 22 * k) return i;
      }
    }
    return -1;
  };

  const onCanvasPointerDown = (e) => {
    if (e.button !== 0) return;
    // A click while a text field is open just places that text
    if (textDraft) {
      commitTextDraft();
      return;
    }
    const p = canvasPos(e);
    const idx = findAnnotationAt(p);
    if (idx >= 0) {
      // Drag the existing annotation (text or arrow), in any tool mode
      pushUndo();
      const a = annotations[idx];
      const anchor = a.type === 'arrow' ? { x: a.x1, y: a.y1 } : { x: a.x, y: a.y };
      dragAnnRef.current = { index: idx, dx: p.x - anchor.x, dy: p.y - anchor.y };
    } else if (editTool === 'arrow') {
      arrowRef.current = { x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: arrowColor };
    } else {
      setTextDraft({ x: p.x, y: p.y, value: '' });
      return;
    }
    // Keep getting moves and the release even if the pointer leaves the canvas mid-drag
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onCanvasPointerMove = (e) => {
    if (dragAnnRef.current) {
      const p = canvasPos(e);
      const { index, dx, dy } = dragAnnRef.current;
      setAnnotations(prev => prev.map((a, i) => {
        if (i !== index) return a;
        if (a.type === 'arrow') {
          return {
            ...a,
            x1: p.x - dx, y1: p.y - dy,
            x2: p.x - dx + (a.x2 - a.x1),
            y2: p.y - dy + (a.y2 - a.y1)
          };
        }
        return { ...a, x: p.x - dx, y: p.y - dy };
      }));
    } else if (arrowRef.current) {
      const p = canvasPos(e);
      arrowRef.current = { ...arrowRef.current, x2: p.x, y2: p.y };
      setTempArrow(arrowRef.current);
    } else {
      // Show the move cursor over any text or arrow that can be dragged
      setHoverAnn(findAnnotationAt(canvasPos(e)) >= 0);
    }
  };

  const onCanvasPointerUp = () => {
    // Read the arrow from the ref, not tempArrow state: on a quick flick the release arrives
    // before React re-renders with the last move, and the arrow used to be dropped
    const arrow = arrowRef.current;
    if (arrow && Math.hypot(arrow.x2 - arrow.x1, arrow.y2 - arrow.y1) >= 8) {
      pushUndo();
      setAnnotations(prev => [...prev, { type: 'arrow', ...arrow }]);
    }
    arrowRef.current = null;
    dragAnnRef.current = null;
    setTempArrow(null);
  };

  const commitTextDraft = () => {
    if (textDraft && textDraft.value.trim()) {
      pushUndo();
      setAnnotations(prev => [...prev, { type: 'text', x: textDraft.x, y: textDraft.y, text: textDraft.value.trim() }]);
    }
    setTextDraft(null);
  };

  const saveEditedImage = async () => {
    const img = editImageRef.current;
    if (!editingFile || !canvasRef.current || !img) return;
    const ext = (editingFile.name.substring(editingFile.name.lastIndexOf('.')) || '.jpg').toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const folder = editedFolderFor(editingFile.folder);
    // Save under exactly the name the user typed. Only strip characters that are illegal in a
    // path, and add _2, _3, ... if that name is already used in this folder.
    const fallback = editingFile.name.replace(/\.[^.]+$/, '') || 'image';
    const typed = (editName.trim() || fallback).replace(/[\\/:*?"<>|]/g, '').replace(/^\.+/, '').trim() || 'image';
    const outExt = ext === '.png' ? '.png' : '.jpg';
    const taken = new Set(files.filter(f => f.folder === folder).map(f => f.name.toLowerCase()));
    let filename = `${typed}${outExt}`;
    for (let n = 2; taken.has(filename.toLowerCase()); n++) {
      filename = `${typed}_${n}${outExt}`;
    }
    const pathname = `${folder}/${filename}`;
    setIsUploading(true);
    setUploadStatus(`Saving edited image to "${folder}"...`);
    try {
      // Render at the image's original resolution, not the smaller size shown in the editor
      const shrink = Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / (img.width * img.height)));
      const out = document.createElement('canvas');
      out.width = Math.floor(img.width * shrink);
      out.height = Math.floor(img.height * shrink);
      paintEdit(out, annotations);
      const blob = await new Promise(res => out.toBlob(res, mime, 0.92));
      if (!blob) throw new Error('Could not render image');
      const uploaded = await upload(pathname, blob, { access: 'public', handleUploadUrl: '/api/upload' });
      await indexFile(uploaded, blob.size);
      showToast(`✓ Saved as "${filename}"`);
      setEditingFile(null);
      setCurrentFolder(folder);
      refreshAfterChange();
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
          <KLogo size={26} /> Koldrop
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

          <div style={{ position: 'absolute', bottom: '20px', right: '20px', display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 'calc(100vw - 40px)' }}>
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
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const deleted = await handleDelete(currentFolderFiles[lightboxIndex].url);
                if (deleted) setLightboxIndex(null);
              }}
              style={{
                padding: '8px 16px', background: '#e84057', color: 'white',
                borderRadius: '8px', border: 'none', fontWeight: 600, fontSize: '14px', cursor: 'pointer'
              }}
            >
              🗑 Delete
            </button>
          </div>
        </div>
      )}

      {/* Image Editor — same full-screen look as the lightbox, with the editing controls along the bottom */}
      {editingFile && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 250,
            display: 'flex', flexDirection: 'column'
          }}
        >
          <button
            onClick={() => setEditingFile(null)}
            style={{
              position: 'absolute', top: '20px', right: '20px', fontSize: '32px', color: 'white',
              background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
              width: '44px', height: '44px', cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', zIndex: 2
            }}
          >
            ✕
          </button>

          {/* Photo (framed exactly like the lightbox) */}
          <div style={{
            flex: 1, minHeight: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', padding: '20px'
          }}>
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <canvas
                ref={canvasRef}
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={onCanvasPointerUp}
                onPointerCancel={onCanvasPointerUp}
                onPointerLeave={() => setHoverAnn(false)}
                // Stop the browser moving focus off the text field we just opened (and selecting page text while dragging)
                onMouseDown={(e) => e.preventDefault()}
                style={{ display: 'block', maxWidth: '90vw', maxHeight: 'calc(100vh - 150px)', width: 'auto', height: 'auto', borderRadius: '8px', cursor: hoverAnn ? 'move' : editTool === 'text' ? 'text' : 'crosshair', background: '#000', touchAction: 'none' }}
              />
              {textDraft && (() => {
                const canvas = canvasRef.current;
                return (
                  <input
                    autoFocus
                    value={textDraft.value}
                    onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitTextDraft();
                      if (e.key === 'Escape') setTextDraft(null);
                    }}
                    onBlur={commitTextDraft}
                    placeholder="Type text, Enter to place"
                    style={{
                      position: 'absolute',
                      // The wrapper is exactly the canvas, so canvas coords map to percentages
                      left: `${(textDraft.x / canvas.width) * 100}%`,
                      top: `${(textDraft.y / canvas.height) * 100}%`,
                      transform: 'translateY(-50%)',
                      background: 'rgba(0,0,0,0.9)',
                      color: '#fff',
                      border: '1px solid #6c63ff',
                      borderRadius: '6px',
                      padding: '4px 8px',
                      fontSize: '14px',
                      outline: 'none',
                      minWidth: '100px',
                      zIndex: 10
                    }}
                  />
                );
              })()}
            </div>
          </div>

          {/* Editing controls pinned to the bottom */}
          <div style={{
            background: 'rgba(18,18,18,0.97)', borderTop: '1px solid #333',
            padding: '10px 16px 14px'
          }}>
            <div style={{ fontSize: '11px', color: '#777', marginBottom: '8px', textAlign: 'center' }}>
              {editTool === 'arrow' ? 'Drag on the image to draw an arrow' : 'Click the image to place text'}
              {' • '}drag any text or arrow to move it • Ctrl+Z / Ctrl+Y
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => { setArrowColor('#ff3b30'); setEditTool('arrow'); }}
                title="Draw arrows in red"
                aria-label="Red arrow color"
                style={{
                  width: '26px', height: '26px', borderRadius: '50%', padding: 0, cursor: 'pointer',
                  background: '#ff3b30', border: arrowColor === '#ff3b30' ? '3px solid #fff' : '3px solid rgba(255,255,255,0.25)'
                }}
              />
              <button
                onClick={() => { setArrowColor('#34c759'); setEditTool('arrow'); }}
                title="Draw arrows in green"
                aria-label="Green arrow color"
                style={{
                  width: '26px', height: '26px', borderRadius: '50%', padding: 0, cursor: 'pointer',
                  background: '#34c759', border: arrowColor === '#34c759' ? '3px solid #fff' : '3px solid rgba(255,255,255,0.25)'
                }}
              />
              <button
                onClick={() => setEditTool('arrow')}
                style={editTool === 'arrow' ? btnPrimary : btnGhost}
                title="Drag on the image to draw an arrow"
              >
                ↗️ Add arrow
              </button>
              <button
                onClick={() => setEditTool('text')}
                style={editTool === 'text' ? btnPrimary : btnGhost}
                title="Click on the image to add text"
              >
                🅣 Add text
              </button>
              <button onClick={undo} style={btnGhost} title="Undo (Ctrl+Z)">↩ Undo</button>
              <button onClick={redo} style={btnGhost} title="Redo (Ctrl+Y)">↪ Redo</button>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="File name"
                title="File name"
                style={{ background: '#252525', border: '1px solid #333', color: '#e8e8e8', padding: '7px 12px', borderRadius: '8px', fontSize: '13px', outline: 'none', width: '160px' }}
              />
              <button onClick={() => setEditingFile(null)} style={btnGhost}>Cancel</button>
              <button onClick={saveEditedImage} disabled={isUploading} style={btnPrimary}>
                💾 Save to "{editedFolderFor(editingFile.folder)}"
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

// Liquid "K" logo mark, shared by the header (the favicon version lives in app/icon.svg)
const KLogo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ display: 'block', flex: '0 0 auto' }}>
    <defs>
      <linearGradient id="kLogoBg" x1="10%" y1="0%" x2="90%" y2="100%">
        <stop offset="0%" stopColor="#9d8fff" />
        <stop offset="45%" stopColor="#6c63ff" />
        <stop offset="100%" stopColor="#382ac4" />
      </linearGradient>
    </defs>
    {/* Liquid blob */}
    <path d="M51 4 C73 2 93 17 95 41 C97 65 79 94 52 96 C27 98 5 77 5 51 C5 27 28 6.5 51 4 Z" fill="url(#kLogoBg)" />
    {/* Glossy sheen */}
    <ellipse cx="35" cy="27" rx="25" ry="15" fill="#ffffff" opacity="0.25" transform="rotate(-22 35 27)" />
    {/* Letter K */}
    <g fill="none" stroke="#ffffff" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round">
      <path d="M38 27 L38 73" />
      <path d="M63 28 L41 50 L63 72" />
    </g>
  </svg>
);

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
