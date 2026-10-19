'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { uploadFile, backfillThumbnail } from '../lib/upload';
import { nextWipe } from '../lib/cleanup-schedule';
import { createClient as createSupabase } from '../lib/supabase/browser';
import { MAX_UPLOAD_BYTES } from '../lib/supabase/config';
import JSZip from 'jszip';

// Folders every new account starts with. They can be removed and others added in
// Settings → Folders; the list is saved on the account, so it's the same on every device.
const DEFAULT_FOLDERS = ['android', 'ios', 'android edited', 'ios edited'];

// Folder names: no slashes or control characters, single spaces, max 50 characters
const cleanFolderName = (name) =>
  String(name || '').replace(/[\\/\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);

// Biggest canvas iOS Safari can export (4096 x 4096 worth of pixels); larger photos are scaled down to this when saving edits
const MAX_EXPORT_PIXELS = 4096 * 4096;

// The editor canvas keeps (near) full resolution and is scaled down with CSS, so it looks as
// sharp and as large as the lightbox. Capped on the long side so huge photos stay quick to redraw.
const MAX_EDIT_DIM = 3000;

// Annotation sizes (font, stroke, arrow head) are authored against a ~1000px canvas and scaled
// with the real resolution, so they look the same on screen and in the full-resolution export.
const annK = (w, h) => Math.max(0.6, Math.min(6, Math.sqrt(w * h) / 1000));

// Default destination for edits when none was chosen in Settings → Folders: "android" ->
// "android edited", and an already-edited folder stays put instead of "… edited edited".
const editedFolderFor = (folder) => `${String(folder || 'general').replace(/\s+edited$/i, '')} edited`;

// Folders like "android edited edited" came from an old bug and should never be shown or kept
const isStrayEditFolder = (name) => /(?:\s+edited){2,}$/i.test(String(name || ''));

export default function Home() {
  const [files, setFiles] = useState([]);
  const [userEmail, setUserEmail] = useState('');
  const [quota, setQuota] = useState(null); // { used, limit } — limit null = unlimited
  const [isAdminUser, setIsAdminUser] = useState(false); // sees the Reports inbox
  const [storageTotal, setStorageTotal] = useState(null); // { used, cap } — admin accounts only
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
  const [tempShape, setTempShape] = useState(null); // arrow / box / crop being drawn
  const [editTool, setEditTool] = useState('arrow'); // 'arrow' | 'box' | 'text' | 'crop'
  const [arrowColor, setArrowColor] = useState('#ff3b30'); // arrows, boxes & text: red (default) or green
  const [selectedAnn, setSelectedAnn] = useState(-1);
  // Colour for new arrows, boxes and text; also recolours whatever is selected
  const pickColor = (c) => {
    setArrowColor(c);
    if (editTool === 'crop') setEditTool('arrow');
    const a = annotations[selectedAnn];
    if (!a || a.type === 'crop' || a.color === c) return;
    pushUndo(); // so Ctrl+Z restores the old colour
    setAnnotations((prev) => prev.map((x, i) => (i === selectedAnn ? { ...x, color: c } : x)));
  };
  const [editorReady, setEditorReady] = useState(false); // image loaded into the editor canvas // index of the box/crop/arrow/text last touched
  const [textDraft, setTextDraft] = useState(null);
  const [hoverAnn, setHoverAnn] = useState(false);
  const canvasRef = useRef(null);
  const editImageRef = useRef(null);
  const shapeRef = useRef(null);
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
  // True only when the folder was picked in Settings (not by a multi-file save), so single
  // downloads don't silently land in a folder picked for an earlier batch
  const settingsDirChosenRef = useRef(false);
  // Files are always removed from cloud storage once downloaded (keeps everyone inside the free storage)
  const deleteAfterDownload = true;
  // { folders: [...names in tab order], editTargets: { source: destination } } — saved on the account
  const [folderPrefs, setFolderPrefs] = useState(null);
  const [settingsTab, setSettingsTab] = useState('general'); // general | download | folders | feedback
  // The feedback screen is a sub-page: reopening Settings always starts on the menus
  useEffect(() => {
    if (showSettings) setSettingsTab((t) => (t === 'feedback' ? 'general' : t));
  }, [showSettings]);
  const [newFolderName, setNewFolderName] = useState('');

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
    localStorage.removeItem('image_drop_delete_after_download'); // old setting, no longer used
    // Folder list + edit destinations live on the account (synced across devices).
    // First time: start from this browser's old folder list, or the defaults.
    (async () => {
      try {
        const { data } = await createSupabase().auth.getUser();
        const saved = data?.user?.user_metadata?.koldrop_folders;
        if (saved && Array.isArray(saved.folders)) {
          setFolderPrefs({ folders: saved.folders, editTargets: saved.editTargets || {} });
          return;
        }
        let start = DEFAULT_FOLDERS;
        try {
          const old = JSON.parse(localStorage.getItem('image_drop_known_folders') || 'null');
          if (Array.isArray(old) && old.length) {
            start = Array.from(new Set([...DEFAULT_FOLDERS, ...old.map(cleanFolderName)]))
              .filter((n) => n && !isStrayEditFolder(n));
          }
        } catch {}
        const prefs = { folders: start, editTargets: {} };
        setFolderPrefs(prefs);
        await createSupabase().auth.updateUser({ data: { koldrop_folders: prefs } });
        localStorage.removeItem('image_drop_known_folders');
      } catch {
        setFolderPrefs({ folders: DEFAULT_FOLDERS, editTargets: {} });
      }
    })();
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
      if (data.user?.email) setUserEmail(data.user.email);
      if (data.quota) setQuota(data.quota);
      setStorageTotal(data.storageTotal || null);
      setIsAdminUser(Boolean(data.user?.admin));

    } catch (err) {
      console.error(err);
    } finally {
      if (seq === loadSeqRef.current) setIsRefreshing(false);
    }
  };

  // Reload after uploading or deleting, bypassing the server's (now stale) list cache
  // Reload after uploading or deleting. Called once per action (a whole batch of uploads is one
  // call), and tells your other open tabs/devices to reload once too.
  const refreshAfterChange = ({ notify = true } = {}) => {
    lastChangeRef.current = Date.now();
    loadFiles(true);
    if (notify) notifyOtherTabs();
  };

  useEffect(() => {
    loadFiles();
  }, [currentFolder]);

  const loadFilesRef = useRef(loadFiles);
  loadFilesRef.current = loadFiles; // always call the latest version (current folder etc.)

  // Live updates: one private channel per account. When you upload/delete on one device, that
  // device sends a single "changed" signal (one per batch, not per file) and every other open
  // tab of yours reloads its list once. No polling.
  const liveChannelRef = useRef(null);
  const notifyOtherTabs = () => {
    const ch = liveChannelRef.current;
    if (ch) ch.send({ type: 'broadcast', event: 'changed', payload: {} }).catch(() => {});
  };
  useEffect(() => {
    let cancelled = false;
    let channel = null;
    let pending = null;
    (async () => {
      const supabase = createSupabase();
      const { data } = await supabase.auth.getUser();
      const uid = data?.user?.id;
      if (!uid || cancelled) return;
      await supabase.realtime.setAuth(); // private channel: only this account may join
      channel = supabase
        .channel(`koldrop:${uid}`, { config: { private: true, broadcast: { self: false } } })
        .on('broadcast', { event: 'changed' }, () => {
          // Collapse bursts into one reload
          clearTimeout(pending);
          pending = setTimeout(() => loadFilesRef.current(true), 400);
        })
        .subscribe();
      liveChannelRef.current = channel;
    })();
    return () => {
      cancelled = true;
      clearTimeout(pending);
      liveChannelRef.current = null;
      if (channel) createSupabase().removeChannel(channel);
    };
  }, []);

  // Coming back to the tab (e.g. after the laptop slept and may have missed a signal): reload once
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') loadFilesRef.current(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Clear selections when switching folder
  useEffect(() => {
    setSelectedUrls(new Set());
  }, [currentFolder]);

  const handleUpload = async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setIsUploading(true);
    setUploadProgress(0);

    const folder = cleanFolderName(folderInput) || 'general';
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
        await uploadFile(pathname, file);
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

  // Tabs: the account's folders in their saved order, then any other folder that has files
  const folders = useMemo(() => {
    const counts = {};
    files.forEach((f) => { if (f.folder) counts[f.folder] = (counts[f.folder] || 0) + 1; });
    const saved = folderPrefs?.folders || DEFAULT_FOLDERS;
    const extra = Object.keys(counts)
      .filter((n) => !saved.includes(n) && (!isStrayEditFolder(n) || counts[n] > 0))
      .sort((x, y) => x.localeCompare(y));
    return [...saved, ...extra].map((name) => ({ name, count: counts[name] || 0 }));
  }, [files, folderPrefs]);

  // Keep a valid folder selected
  useEffect(() => {
    if (!folders.length) return;
    if (currentFolder && folders.some((f) => f.name === currentFolder)) return;
    const savedLast = localStorage.getItem('image_drop_last_folder');
    const pick = savedLast && folders.some((f) => f.name === savedLast) ? savedLast : folders[0].name;
    setCurrentFolder(pick);
    setFolderInput(pick);
  }, [folders]);

  const saveFolderPrefs = async (next) => {
    setFolderPrefs(next);
    const { error } = await createSupabase().auth.updateUser({ data: { koldrop_folders: next } });
    if (error) showToast(`❌ Couldn't save folder settings: ${error.message}`);
  };

  // Where edits of files in `folder` are saved
  const editTargetFor = (folder) => folderPrefs?.editTargets?.[folder] || editedFolderFor(folder);

  const handleAddFolder = async () => {
    const name = cleanFolderName(newFolderName);
    if (!name) return;
    if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      showToast(`Folder "${name}" already exists`);
      return;
    }
    const prefs = folderPrefs || { folders: DEFAULT_FOLDERS, editTargets: {} };
    await saveFolderPrefs({ ...prefs, folders: [...prefs.folders, name] });
    setNewFolderName('');
    showToast(`✓ Added folder "${name}"`);
  };

  const setEditTarget = (source, dest) => {
    const prefs = folderPrefs || { folders: DEFAULT_FOLDERS, editTargets: {} };
    saveFolderPrefs({ ...prefs, editTargets: { ...prefs.editTargets, [source]: dest } });
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

  // Fetch a file's bytes and make sure we really got the whole file. Throws a readable error
  // otherwise — callers must never delete a file whose download didn't succeed.
  const fetchFileBlob = async (file) => {
    // ?download=1 is a different URL from the one the viewer/grid loaded, so a stale cached
    // response can't be reused; no-store makes the browser ask the server every time.
    const res = await fetch(`${file.url}?download=1`, { cache: 'no-store' });
    if (res.status === 404) {
      const err = new Error('This file is no longer available — it was probably already downloaded or deleted on another device.');
      err.gone = true;
      throw err;
    }
    if (res.status === 401) throw new Error('Your session expired. Reload the page and try again.');
    if (!res.ok) throw new Error(`Server error (${res.status})`);
    const blob = await res.blob();
    if (!blob.size || (file.size && blob.size !== Number(file.size))) {
      throw new Error('The download was incomplete. Nothing was deleted — try again.');
    }
    return blob;
  };

  // Save a Blob through the browser's normal download (goes to the Downloads folder)
  const browserSave = (blob, filename) => {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 120000);
  };

  // Download a single file. Goes to the browser's Downloads folder, or to the folder chosen in
  // Settings. It's removed from Koldrop only after the whole file was received.
  const downloadSingleFile = async (file) => {
    showToast(`Downloading ${file.name}...`);
    let blob;
    try {
      blob = await fetchFileBlob(file);
    } catch (err) {
      showToast(`❌ ${err.message}`);
      if (err.gone) refreshAfterChange({ notify: false }); // drop it from this tab's stale list
      return;
    }

    let where = 'Downloads';
    try {
      const savedDirect = settingsDirChosenRef.current && (await saveFileToDirectory(file.name, blob));
      if (savedDirect) where = customDirName;
      else browserSave(blob, file.name);
    } catch (err) {
      showToast(`❌ Could not save the file: ${err.message}`);
      return;
    }

    if (deleteAfterDownload) {
      await deleteFilesSilently([file.url], { quiet: true });
    }
    showToast(`✓ Saved ${file.name} to ${where}`);
  };

  // Download files (either selected or entire folder) as a ZIP archive
  const downloadAsZip = async (filesToDownload, zipName) => {
    if (filesToDownload.length === 0) return;
    setIsZipping(true);
    setZipProgress(`Preparing 0/${filesToDownload.length}...`);

    try {
      const zip = new JSZip();
      let completed = 0;

      const included = [];
      const failed = [];
      for (const item of filesToDownload) {
        try {
          const blob = await fetchFileBlob(item);
          zip.file(item.name, blob);
          included.push(item);
        } catch (e) {
          console.error(`Failed to fetch ${item.name}`, e);
          failed.push(item.name);
        }
        completed++;
        setZipProgress(`Downloading ${completed}/${filesToDownload.length}...`);
      }

      if (!included.length) throw new Error('None of the files could be downloaded. Nothing was deleted.');

      setZipProgress('Generating ZIP package...');
      const zipContent = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        setZipProgress(`Zipping... ${Math.round(metadata.percent)}%`);
      });

      const finalName = `${zipName}.zip`;
      const savedDirect = await saveFileToDirectory(finalName, zipContent);
      if (!savedDirect) browserSave(zipContent, finalName);

      // Only the files that are actually inside the ZIP are removed
      if (deleteAfterDownload) {
        await deleteFilesSilently(included.map(f => f.url), { quiet: true });
      }
      showToast(failed.length
        ? `⚠️ ${finalName} saved without ${failed.length} file(s) that couldn't be downloaded (they were kept)`
        : `✓ ${savedDirect ? `ZIP saved to ${customDirName}` : `Downloaded ${finalName}`}`);
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

    let folderLabel = customDirName; // shown in the final toast; set here (before the picker) to avoid TDZ

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
    for (let i = 0; i < filesToDownload.length; i++) {
      const file = filesToDownload[i];
      setZipProgress(`Saving ${i + 1}/${filesToDownload.length}: ${file.name}...`);
      try {
        const blob = await fetchFileBlob(file);
        const savedDirect = await saveFileToDirectory(file.name, blob);
        if (!savedDirect) {
          browserSave(blob, file.name);
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
    // Only files that were really saved are removed
    if (deleteAfterDownload && downloadedUrls.length > 0) {
      await deleteFilesSilently(downloadedUrls, { quiet: true });
    }
    const failedCount = filesToDownload.length - savedCount;
    showToast(failedCount
      ? `⚠️ Saved ${savedCount} file(s); ${failedCount} couldn't be downloaded and were kept`
      : customDirHandleRef.current
        ? `✓ Saved ${savedCount} file(s) to ${folderLabel}!`
        : `✓ Downloaded ${savedCount} file(s) individually!`);
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
    const count = files.filter(f => f.folder === folderName).length;
    if (!confirm(count
      ? `Delete folder "${folderName}" and the ${count} file(s) inside?`
      : `Remove folder "${folderName}"?`)) return;

    try {
      const folderFiles = files.filter(f => f.folder === folderName);
      if (folderFiles.length > 0) {
        await fetch('/api/files', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: folderFiles.map(f => f.url) }),
        });
      }

      // Remove it from the account's folders, and any edit destinations pointing at it
      const prefs = folderPrefs || { folders: DEFAULT_FOLDERS, editTargets: {} };
      const editTargets = Object.fromEntries(
        Object.entries(prefs.editTargets || {}).filter(([src, dest]) => src !== folderName && dest !== folderName)
      );
      const remainingFolders = prefs.folders.filter(name => name !== folderName);
      await saveFolderPrefs({ folders: remainingFolders, editTargets });
      const updatedFolders = remainingFolders;

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

  // Silently delete files from storage (for auto-delete on download)
  const deleteFilesSilently = async (urls, { quiet = false } = {}) => {
    try {
      await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      setSelectedUrls(new Set());
      refreshAfterChange();
      if (!quiet) showToast('🧹 Cleaned up downloaded files');
    } catch (e) {
      console.warn('Failed auto-delete cleanup:', e);
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
      settingsDirChosenRef.current = true;
      setCustomDirHandle(dirHandle);
      setCustomDirName(dirHandle.name);
      setAutoSaveDirect(true);
      showToast(`✓ Set download folder: ${dirHandle.name}`);
    } catch (err) {
      console.warn('Folder selection aborted or denied', err);
    }
  };

  // Sign out: end the Supabase session, forget this account's folders, back to the login screen
  const handleLogout = async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (err) {
      console.warn('Logout failed', err);
    }
    localStorage.removeItem('image_drop_known_folders');
    localStorage.removeItem('image_drop_last_folder');
    window.location.href = '/login';
  };

  // ---- Image editor ----
  const openEditor = (file) => {
    setEditingFile(file);
    setEditName(file.name.substring(0, file.name.lastIndexOf('.')) || file.name);
    setAnnotations([]);
    annotationsRef.current = [];
    undoStackRef.current = [];
    redoStackRef.current = [];
    setTempShape(null);
    setTextDraft(null);
    setHoverAnn(false);
    setSelectedAnn(-1);
    setEditorReady(false);
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

  // Rectangle from two corners, always with positive width/height
  const rectFrom = (x1, y1, x2, y2) => ({
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
  });
  const cropOf = (list) => (list || []).find((a) => a.type === 'crop') || null;

  // Paint the image and annotations onto a canvas of any size. Annotations are stored in
  // editor-canvas coordinates. For the editor view (`preview`) the crop is shown as a dimmed
  // overlay with handles; for export the output is cut to the crop area at full resolution.
  const paintEdit = (target, list, { preview = false, selected = -1 } = {}) => {
    const view = canvasRef.current;
    const ctx = target.getContext('2d');
    const crop = preview ? null : cropOf(list);
    const area = crop || { x: 0, y: 0, w: view.width, h: view.height };
    const sx = target.width / area.w;
    const sy = target.height / area.h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.setTransform(sx, 0, 0, sy, -area.x * sx, -area.y * sy);
    ctx.drawImage(editImageRef.current, 0, 0, view.width, view.height);
    const k = annK(view.width, view.height);

    const drawOne = (a) => {
      if (a.type === 'crop') return; // shown as an overlay / applied on export
      if (a.type === 'text') {
        ctx.font = `bold ${32 * k}px sans-serif`;
        ctx.textBaseline = 'middle'; // (x, y) is the left middle of the text, where the text field sat
        ctx.lineWidth = 6 * k;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = a.color || '#ffffff';
        ctx.strokeText(a.text, a.x, a.y);
        ctx.fillText(a.text, a.x, a.y);
      } else if (a.type === 'box') {
        ctx.lineJoin = 'round';
        // Dark edge under the colour, like the arrows, so it shows on any background
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 8 * k;
        ctx.strokeRect(a.x, a.y, a.w, a.h);
        ctx.strokeStyle = a.color || '#ff3b30';
        ctx.lineWidth = 5 * k;
        ctx.strokeRect(a.x, a.y, a.w, a.h);
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

    if (preview) {
      const handles = (r) => {
        const hs = 12 * k;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 2 * k;
        rectCorners(r).forEach(([cx, cy]) => {
          ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
          ctx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs);
        });
      };
      // Crop: dim everything outside the kept area
      const c = cropOf(list);
      if (c) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        ctx.rect(0, 0, view.width, view.height);
        ctx.rect(c.x, c.y, c.w, c.h);
        ctx.fill('evenodd');
        ctx.setLineDash([10 * k, 6 * k]);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * k;
        ctx.strokeRect(c.x, c.y, c.w, c.h);
        ctx.setLineDash([]);
        handles(c);
      }
      // Resize handles on the selected box
      const sel = list[selected];
      if (sel && sel.type === 'box') handles(sel);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  const rectCorners = (r) => [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !editImageRef.current) return;
    let list = annotations;
    if (tempShape) {
      // A new crop replaces the old one while it's being drawn
      list = tempShape.type === 'crop' ? [...annotations.filter((a) => a.type !== 'crop'), tempShape] : [...annotations, tempShape];
    }
    paintEdit(canvas, list, { preview: true, selected: tempShape ? -1 : selectedAnn });
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
    setSelectedAnn(-1);
    setAnnotations(undoStackRef.current.pop());
  };
  const redo = () => {
    if (redoStackRef.current.length === 0) return;
    undoStackRef.current.push(snapshot(annotationsRef.current));
    setTextDraft(null);
    setSelectedAnn(-1);
    setAnnotations(redoStackRef.current.pop());
  };

  // Remove the selected annotation (Delete key / button)
  const deleteSelected = () => {
    if (selectedAnn < 0 || !annotations[selectedAnn]) return;
    pushUndo();
    setAnnotations((prev) => prev.filter((_, i) => i !== selectedAnn));
    setSelectedAnn(-1);
  };
  const deleteSelectedRef = useRef(deleteSelected);
  deleteSelectedRef.current = deleteSelected;

  // Load the image once when the editor opens
  useEffect(() => {
    if (!editingFile) { editImageRef.current = null; return; }
    let cancelled = false;
    let objectUrl = null;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      editImageRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Keep (near) full resolution and let CSS fit it to the screen — that way the editor is
      // as large and as sharp as the lightbox, and the saved edit stays high quality
      const scale = Math.min(1, MAX_EDIT_DIM / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      redraw();
      setEditorReady(true);
    };
    img.onerror = () => {
      if (cancelled) return;
      showToast('❌ Could not load image for editing');
      setEditingFile(null);
    };
    // Load our own fresh copy as a local blob: a same-origin image never taints the canvas, so
    // the edit can be exported, and a copy cached by the viewer (without CORS headers) can't
    // get in the way.
    fetchFileBlob(editingFile)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        img.src = objectUrl;
      })
      .catch((err) => {
        if (cancelled) return;
        showToast(`❌ Could not load image for editing: ${err.message}`);
        setEditingFile(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [editingFile]);

  // Redraw when annotations change
  useEffect(() => {
    if (editingFile) redraw();
  }, [annotations, tempShape, selectedAnn]);

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
      // Delete / Backspace removes the selected box, arrow, text or crop
      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        deleteSelectedRef.current();
        return;
      }
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

  // Near the outline of a rectangle (not inside it, so you can still draw arrows inside a box)
  const nearRectEdge = (p, r, m) =>
    p.x >= r.x - m && p.x <= r.x + r.w + m && p.y >= r.y - m && p.y <= r.y + r.h + m &&
    !(p.x > r.x + m && p.x < r.x + r.w - m && p.y > r.y + m && p.y < r.y + r.h - m);

  // Corner handle of the selected box (or the crop) under p → which corner stays fixed
  const findHandleAt = (p) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const k = annK(canvas.width, canvas.height);
    const candidates = [];
    if (annotations[selectedAnn]?.type === 'box') candidates.push(selectedAnn);
    const ci = annotations.findIndex((a) => a.type === 'crop');
    if (ci >= 0) candidates.push(ci);
    for (const index of candidates) {
      const r = annotations[index];
      const corners = rectCorners(r);
      for (let c = 0; c < 4; c++) {
        const [cx, cy] = corners[c];
        if (Math.hypot(p.x - cx, p.y - cy) <= 16 * k) {
          const [fx, fy] = corners[3 - c]; // the opposite corner
          return { index, fixed: { x: fx, y: fy } };
        }
      }
    }
    return null;
  };

  // Find the topmost annotation under point p
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
      } else if (a.type === 'box' || a.type === 'crop') {
        if (nearRectEdge(p, a, 12 * k)) return i;
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
    const handle = findHandleAt(p);
    const idx = handle ? -1 : findAnnotationAt(p);
    if (handle) {
      // Resize a box or the crop by its corner
      pushUndo();
      setSelectedAnn(handle.index);
      dragAnnRef.current = { index: handle.index, mode: 'resize', fixed: handle.fixed };
    } else if (idx >= 0) {
      // Drag the existing annotation, in any tool mode
      pushUndo();
      setSelectedAnn(idx);
      const a = annotations[idx];
      const anchor = a.type === 'arrow' ? { x: a.x1, y: a.y1 } : { x: a.x, y: a.y };
      dragAnnRef.current = { index: idx, mode: 'move', dx: p.x - anchor.x, dy: p.y - anchor.y };
    } else if (editTool === 'text') {
      setSelectedAnn(-1);
      setTextDraft({ x: p.x, y: p.y, value: '' });
      return;
    } else {
      setSelectedAnn(-1);
      // Arrow, box or crop: drag out from here
      shapeRef.current = { type: editTool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: arrowColor };
    }
    // Keep getting moves and the release even if the pointer leaves the canvas mid-drag
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  // What the shape being drawn looks like as an annotation
  const shapeToAnnotation = (sh) => {
    if (!sh) return null;
    if (sh.type === 'arrow') return { type: 'arrow', x1: sh.x1, y1: sh.y1, x2: sh.x2, y2: sh.y2, color: sh.color };
    const r = rectFrom(sh.x1, sh.y1, sh.x2, sh.y2);
    return sh.type === 'crop' ? { type: 'crop', ...r } : { type: 'box', ...r, color: sh.color };
  };

  const onCanvasPointerMove = (e) => {
    if (dragAnnRef.current) {
      const p = canvasPos(e);
      const canvas = canvasRef.current;
      const drag = dragAnnRef.current;
      setAnnotations(prev => prev.map((a, i) => {
        if (i !== drag.index) return a;
        if (drag.mode === 'resize') {
          return { ...a, ...rectFrom(drag.fixed.x, drag.fixed.y, p.x, p.y) };
        }
        if (a.type === 'arrow') {
          return {
            ...a,
            x1: p.x - drag.dx, y1: p.y - drag.dy,
            x2: p.x - drag.dx + (a.x2 - a.x1),
            y2: p.y - drag.dy + (a.y2 - a.y1)
          };
        }
        if (a.type === 'crop') {
          // The crop can't be dragged off the picture
          return {
            ...a,
            x: Math.max(0, Math.min(canvas.width - a.w, p.x - drag.dx)),
            y: Math.max(0, Math.min(canvas.height - a.h, p.y - drag.dy)),
          };
        }
        return { ...a, x: p.x - drag.dx, y: p.y - drag.dy };
      }));
    } else if (shapeRef.current) {
      const p = canvasPos(e);
      shapeRef.current = { ...shapeRef.current, x2: p.x, y2: p.y };
      setTempShape(shapeToAnnotation(shapeRef.current));
    } else {
      // Move/resize cursors over anything that can be dragged
      const p = canvasPos(e);
      setHoverAnn(findHandleAt(p) ? 'resize' : findAnnotationAt(p) >= 0 ? 'move' : false);
    }
  };

  const onCanvasPointerUp = () => {
    // Read the shape from the ref, not tempShape state: on a quick flick the release arrives
    // before React re-renders with the last move, and the shape used to be dropped
    const sh = shapeRef.current;
    if (sh && Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1) >= 8) {
      const ann = shapeToAnnotation(sh);
      const isRect = ann.type !== 'arrow';
      if (!isRect || (ann.w >= 8 && ann.h >= 8)) {
        pushUndo();
        const base = ann.type === 'crop' ? annotations.filter((x) => x.type !== 'crop') : annotations;
        const next = [...base, ann];
        setAnnotations(next);
        setSelectedAnn(next.length - 1);
      }
    }
    // A resize that ended "inside out" or too small is normalised by rectFrom already
    shapeRef.current = null;
    dragAnnRef.current = null;
    setTempShape(null);
  };

  const commitTextDraft = () => {
    if (textDraft && textDraft.value.trim()) {
      pushUndo();
      setAnnotations(prev => [...prev, { type: 'text', x: textDraft.x, y: textDraft.y, text: textDraft.value.trim(), color: arrowColor }]);
    }
    setTextDraft(null);
  };

  // The finished image at full resolution, cut to the crop if there is one
  const renderEdited = () => {
    const img = editImageRef.current;
    const view = canvasRef.current;
    if (!img || !view) return null;
    const crop = cropOf(annotations);
    const fx = img.width / view.width;
    const fy = img.height / view.height;
    const w = (crop ? crop.w : view.width) * fx;
    const h = (crop ? crop.h : view.height) * fy;
    // Biggest canvas iOS can export; larger results are scaled down to it
    const shrink = Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / (w * h)));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.floor(w * shrink));
    out.height = Math.max(1, Math.floor(h * shrink));
    paintEdit(out, annotations);
    return out;
  };

  // Copy the edited image (PNG) to the clipboard, ready to paste into Jira / Slack / Teams
  const copyEditedImage = async () => {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      showToast('❌ This browser can\'t copy images — use Save instead');
      return;
    }
    try {
      const out = renderEdited();
      if (!out) return;
      // Pass a promise so Safari keeps the click as the user gesture while the PNG is made
      const png = new Promise((resolve, reject) =>
        out.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render image'))), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      showToast('✓ Copied — paste it anywhere (Ctrl+V)');
    } catch (err) {
      showToast(`❌ Copy failed: ${err.message || 'not allowed'}`);
    }
  };

  const saveEditedImage = async () => {
    if (!editingFile || !canvasRef.current || !editImageRef.current) return;
    const ext = (editingFile.name.substring(editingFile.name.lastIndexOf('.')) || '.jpg').toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const folder = editTargetFor(editingFile.folder);
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
      // Render at the image's original resolution (cut to the crop), not the editor's size
      const out = renderEdited();
      const blob = await new Promise(res => out.toBlob(res, mime, 0.92));
      if (!blob) throw new Error('Could not render image');
      await uploadFile(pathname, blob);
      showToast(`✓ Saved as "${filename}"`);
      if (folderPrefs && !folderPrefs.folders.includes(folder)) {
        saveFolderPrefs({ ...folderPrefs, folders: [...folderPrefs.folders, folder] });
      }
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
    <div style={{ paddingBottom: '56px' }}>
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
            Supports photos & screen recordings (MP4, MOV, WebM, etc.) • Up to {Math.round(MAX_UPLOAD_BYTES / 1e6)}MB
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
                      // Small preview when there is one; otherwise the full image, loaded with
                      // CORS so a preview can be made from it once (backfill for older files)
                      src={file.thumbUrl || file.url}
                      crossOrigin={file.thumbUrl ? undefined : 'anonymous'}
                      onLoad={file.thumbUrl ? undefined : (e) => backfillThumbnail(file, e.currentTarget)}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              {settingsTab === 'feedback' ? (
                <button
                  onClick={() => setSettingsTab('general')}
                  style={{ background: 'none', border: 'none', color: '#e8e8e8', fontSize: '17px', fontWeight: 700, cursor: 'pointer', padding: 0 }}
                >
                  ← Report a bug / Suggestion
                </button>
              ) : (
                <h3 style={{ margin: 0, fontSize: '18px' }}>⚙️ Settings</h3>
              )}
              <button onClick={() => setShowSettings(false)} style={{ background: 'none', border: 'none', color: '#888', fontSize: '20px', cursor: 'pointer' }}>✕</button>
            </div>

            {/* Menus */}
            {settingsTab !== 'feedback' && <div style={{ display: 'flex', gap: '6px', marginBottom: '18px', background: '#161616', padding: '4px', borderRadius: '10px' }}>
              {[['general', 'General'], ['download', 'Download folder'], ['folders', 'Folders'], ...(isAdminUser ? [['reports', 'Reports']] : [])].map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setSettingsTab(id)}
                  style={{
                    flex: 1, padding: '8px 6px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                    fontSize: '13px', fontWeight: 600,
                    background: settingsTab === id ? '#6c63ff' : 'transparent',
                    color: settingsTab === id ? '#fff' : '#999',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>}

            <div style={{ fontSize: '14px', color: '#bbb', lineHeight: '1.5', marginBottom: '20px', maxHeight: '60vh', overflowY: 'auto' }}>
              {settingsTab === 'general' && (
                <>
                  {quota && (
                    <div style={{ marginBottom: '16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                        <strong>Your storage</strong>
                        <span style={{ color: '#aaa' }}>
                          {(quota.used / 1e6).toFixed(1)} MB{quota.limit ? ` of ${Math.round(quota.limit / 1e6)} MB` : ' · no limit'}
                        </span>
                      </div>
                      {quota.limit && (
                        <div style={{ height: '6px', background: '#2a2a2a', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%', width: `${Math.min(100, (quota.used / quota.limit) * 100)}%`,
                            background: quota.used / quota.limit > 0.9 ? '#e84057' : '#6c63ff',
                          }} />
                        </div>
                      )}
                    </div>
                  )}

                  {storageTotal && (
                    <div style={{ marginBottom: '16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                        <strong>All of Koldrop</strong>
                        <span style={{ color: '#aaa' }}>
                          {(storageTotal.used / 1e9).toFixed(2)} GB of {Math.round(storageTotal.cap / 1e9)} GB
                        </span>
                      </div>
                      <div style={{ height: '6px', background: '#2a2a2a', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', width: `${Math.min(100, (storageTotal.used / storageTotal.cap) * 100)}%`,
                          background: storageTotal.used / storageTotal.cap > 0.9 ? '#e84057' : '#4caf50',
                        }} />
                      </div>
                      <div style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
                        Everyone's files together · uploads stop at the cap · only you can see this
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => setSettingsTab('feedback')}
                    style={{
                      display: 'block', width: '100%', textAlign: 'center', padding: '10px', borderRadius: '8px',
                      background: '#252525', border: '1px solid #333', color: '#e8e8e8',
                      fontWeight: 600, fontSize: '14px', cursor: 'pointer',
                    }}
                  >
                    🐞 Report a bug / Suggestion ›
                  </button>
                </>
              )}

              {settingsTab === 'download' && (
                <>
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

                  <p style={{ fontSize: '13px', color: '#777', margin: '16px 0 0' }}>
                    💡 <em>Tip for Mobile:</em> On iOS and Android, downloads automatically save to your device's Files app or default Downloads folder.
                  </p>

                </>
              )}

              {settingsTab === 'folders' && (
                <>
                  <p style={{ marginTop: 0, fontSize: '13px', color: '#999' }}>
                    Your folders appear as tabs. Choose where edited images from each folder are saved.
                    Saved on your account, so it's the same on every device.
                  </p>

                  <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                    <input
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddFolder(); }}
                      placeholder="New folder name"
                      maxLength={50}
                      style={{ flex: 1, minWidth: 0, background: '#252525', border: '1px solid #333', color: '#e8e8e8', padding: '8px 12px', borderRadius: '8px', fontSize: '13px', outline: 'none' }}
                    />
                    <button onClick={handleAddFolder} style={btnPrimary}>＋ Add</button>
                  </div>

                  {folders.map((f) => (
                    <div key={f.name} style={{ background: '#252525', borderRadius: '8px', padding: '10px 12px', marginBottom: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                        <span style={{ color: '#e8e8e8', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          📁 {f.name} <span style={{ color: '#777', fontWeight: 400, fontSize: '12px' }}>({f.count})</span>
                        </span>
                        <button
                          onClick={() => handleDeleteFolder(f.name)}
                          title={f.count ? 'Remove folder and its files' : 'Remove folder'}
                          style={{ ...btnGhost, color: '#e84057', borderColor: '#4a2a2f', padding: '4px 10px' }}
                        >
                          Remove
                        </button>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', fontSize: '12px', color: '#999' }}>
                        Edits go to
                        <select
                          value={editTargetFor(f.name)}
                          onChange={(e) => setEditTarget(f.name, e.target.value)}
                          style={{ flex: 1, minWidth: 0, background: '#1a1a1a', border: '1px solid #333', color: '#e8e8e8', padding: '6px 8px', borderRadius: '6px', fontSize: '12px' }}
                        >
                          {Array.from(new Set([editTargetFor(f.name), f.name, editedFolderFor(f.name), ...folders.map((o) => o.name)])).map((name) => (
                            <option key={name} value={name}>
                              {name === f.name ? `${name} (same folder)` : folders.some((o) => o.name === name) ? name : `${name} (new)`}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ))}
                </>
              )}

              {settingsTab === 'reports' && isAdminUser && <ReportsInbox />}

              {settingsTab === 'feedback' && <FeedbackForm onBack={() => setSettingsTab('general')} />}
            </div>

            {settingsTab !== 'feedback' && (
              <>
                <button onClick={() => setShowSettings(false)} style={{ ...btnGhost, width: '100%', padding: '10px' }}>
                  Done
                </button>

                <button
                  onClick={handleLogout}
                  style={{ ...btnGhost, width: '100%', padding: '10px', marginTop: '8px', color: '#999' }}
                >
                  Log out{userEmail ? ` (${userEmail})` : ''}
                </button>
              </>
            )}
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

          {/* Photo (framed exactly like the lightbox). Clicking the empty space around it closes
              the editor and goes back to where you were; asks first if there are unsaved edits. */}
          <div
            onClick={(e) => {
              if (e.target !== e.currentTarget) return;
              if (annotations.length && !confirm('Discard your edits?')) return;
              setEditingFile(null);
            }}
            style={{
              flex: 1, minHeight: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', padding: '20px'
            }}
          >
            {!editorReady && (
              // While the editor gets its own copy, show the photo that was already on screen
              <img
                src={editingFile.url}
                alt=""
                style={{ display: 'block', maxWidth: '90vw', maxHeight: 'calc(100vh - 150px)', borderRadius: '8px', opacity: 0.6 }}
              />
            )}
            <div style={{ position: 'relative', display: editorReady ? 'inline-block' : 'none' }}>
              <canvas
                ref={canvasRef}
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={onCanvasPointerUp}
                onPointerCancel={onCanvasPointerUp}
                onPointerLeave={() => setHoverAnn(false)}
                // Stop the browser moving focus off the text field we just opened (and selecting page text while dragging)
                onMouseDown={(e) => e.preventDefault()}
                style={{ display: 'block', maxWidth: '90vw', maxHeight: 'calc(100vh - 150px)', width: 'auto', height: 'auto', borderRadius: '8px', cursor: hoverAnn === 'resize' ? 'nwse-resize' : hoverAnn ? 'move' : editTool === 'text' ? 'text' : 'crosshair', background: '#000', touchAction: 'none' }}
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
                      color: arrowColor,
                      fontWeight: 700,
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
              {{ arrow: 'Drag to draw an arrow', box: 'Drag to draw a box', text: 'Click to place text', crop: 'Drag to choose the area to keep' }[editTool]}
              {' • '}click something to select, drag to move, corners to resize • Ctrl+Z / Ctrl+Y
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => pickColor('#ff3b30')}
                title="Red arrows, boxes and text"
                aria-label="Red"
                style={{
                  width: '26px', height: '26px', borderRadius: '50%', padding: 0, cursor: 'pointer',
                  background: '#ff3b30', border: arrowColor === '#ff3b30' ? '3px solid #fff' : '3px solid rgba(255,255,255,0.25)'
                }}
              />
              <button
                onClick={() => pickColor('#34c759')}
                title="Green arrows, boxes and text"
                aria-label="Green"
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
                ↗️ Arrow
              </button>
              <button
                onClick={() => setEditTool('box')}
                style={editTool === 'box' ? btnPrimary : btnGhost}
                title="Drag on the image to draw a box; drag its corners to resize"
              >
                ▢ Box
              </button>
              <button
                onClick={() => setEditTool('text')}
                style={editTool === 'text' ? btnPrimary : btnGhost}
                title="Click on the image to add text"
              >
                🅣 Text
              </button>
              <button
                onClick={() => setEditTool('crop')}
                style={editTool === 'crop' ? btnPrimary : btnGhost}
                title="Drag to choose the area to keep; drag its corners to adjust"
              >
                ✂️ Crop
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
              <button onClick={copyEditedImage} style={btnGhost} title="Copy the edited image to paste into Jira, Slack, Teams…">📋 Copy</button>
              <button onClick={saveEditedImage} disabled={isUploading} style={btnPrimary}>
                💾 Save to "{editTargetFor(editingFile.folder)}"
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '64px', left: '50%', transform: 'translateX(-50%)',
          background: '#4caf50', color: 'white', padding: '12px 24px', borderRadius: '8px',
          fontSize: '14px', fontWeight: 600, zIndex: 400, boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
        }}>
          {toast}
        </div>
      )}

      <WipeNotice />
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

// Fixed bar at the bottom of the screen: every file is deleted weekly, show when.
function WipeNotice() {
  const [when, setWhen] = useState(null);
  useEffect(() => {
    const update = () => setWhen(nextWipe());
    update();
    const t = setInterval(update, 60 * 1000);
    return () => clearInterval(t);
  }, []);
  if (!when) return null;

  const ms = when.getTime() - Date.now();
  const hours = Math.max(0, Math.round(ms / 3600000));
  const inText = hours < 1 ? 'within the hour' : hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
  const dateText = when.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const soon = hours < 24;

  return (
    <div
      role="note"
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 150,
        background: soon ? 'rgba(232,64,87,0.95)' : 'rgba(30,30,30,0.96)',
        borderTop: `1px solid ${soon ? '#ff6b6b' : '#3a3a3a'}`,
        color: soon ? '#fff' : '#d0d0d0', fontSize: '13px', lineHeight: 1.4,
        padding: '10px 16px', textAlign: 'center', backdropFilter: 'blur(6px)',
      }}
    >
      ⚠️ All files are deleted every week. Next wipe: <strong>{dateText}</strong> ({inText}). Download anything you want to keep.
    </div>
  );
}

// "Report a bug / Suggestion" — a sub-page inside Settings. Emails the owner via /api/feedback.
const FEEDBACK_MAX = 5000;
function FeedbackForm({ onBack }) {
  const [kind, setKind] = useState('bug');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [error, setError] = useState('');

  const send = async () => {
    if (!message.trim() || status === 'sending') return;
    setStatus('sending');
    setError('');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, message, page: navigator.userAgent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send. Please try again.');
      setStatus('sent');
      setMessage('');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  };

  if (status === 'sent') {
    return (
      <div style={{ textAlign: 'center', padding: '20px 0' }}>
        <div style={{ fontSize: '32px', marginBottom: '6px' }}>✅</div>
        <strong style={{ color: '#e8e8e8' }}>Thanks — sent!</strong>
        <p style={{ color: '#999', fontSize: '13px', margin: '6px 0 16px' }}>You may get a reply at your account email.</p>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
          <button onClick={() => setStatus('idle')} style={{ padding: '9px 14px', borderRadius: '8px', border: '1px solid #444', background: 'transparent', color: '#ddd', cursor: 'pointer' }}>
            Send another
          </button>
          <button onClick={onBack} style={{ padding: '9px 14px', borderRadius: '8px', border: 'none', background: '#6c63ff', color: '#fff', cursor: 'pointer' }}>
            Back to settings
          </button>
        </div>
      </div>
    );
  }

  const disabled = !message.trim() || status === 'sending';
  return (
    <div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', background: '#161616', padding: '4px', borderRadius: '10px' }}>
        {[['bug', '🐞 Bug'], ['suggestion', '💡 Suggestion']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setKind(id)}
            style={{
              flex: 1, padding: '8px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
              background: kind === id ? '#6c63ff' : 'transparent', color: kind === id ? '#fff' : '#999',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value.slice(0, FEEDBACK_MAX))}
        placeholder={kind === 'bug'
          ? 'What happened? What did you expect? Steps to make it happen again help a lot.'
          : 'What would you like Koldrop to do?'}
        rows={8}
        autoFocus
        style={{
          width: '100%', boxSizing: 'border-box', background: '#161616', color: '#e8e8e8',
          border: '1px solid #333', borderRadius: '10px', padding: '12px', fontSize: '14px',
          fontFamily: 'inherit', resize: 'vertical', outline: 'none',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', gap: '12px' }}>
        <span style={{ fontSize: '12px', color: status === 'error' ? '#e84057' : '#666' }}>
          {status === 'error' ? error : `${message.length} / ${FEEDBACK_MAX}`}
        </span>
        <button
          onClick={send}
          disabled={disabled}
          style={{
            padding: '9px 22px', borderRadius: '8px', border: 'none', fontWeight: 600, fontSize: '14px',
            background: '#6c63ff', color: '#fff', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
          }}
        >
          {status === 'sending' ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

// Admin-only list of bug reports and suggestions, newest first, each with a delete button.
function ReportsInbox() {
  const [reports, setReports] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all'); // all | bug | suggestion
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    fetch('/api/feedback', { cache: 'no-store' })
      .then((r) => r.json().then((d) => (r.ok ? d : Promise.reject(new Error(d.error || 'Could not load reports')))))
      .then((d) => setReports(d.reports))
      .catch((e) => setError(e.message));
  }, []);

  const remove = async (id) => {
    if (!window.confirm('Delete this report?')) return;
    setDeleting(id);
    try {
      const res = await fetch('/api/feedback', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not delete');
      setReports((list) => list.filter((r) => r.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting(null);
    }
  };

  if (error && !reports) return <p style={{ color: '#e84057', margin: 0 }}>{error}</p>;
  if (!reports) return <p style={{ color: '#888', margin: 0 }}>Loading…</p>;

  const count = (k) => reports.filter((r) => r.kind === k).length;
  const shown = filter === 'all' ? reports : reports.filter((r) => r.kind === filter);

  return (
    <div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
        {[['all', `All (${reports.length})`], ['bug', `🐞 Bugs (${count('bug')})`], ['suggestion', `💡 Ideas (${count('suggestion')})`]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            style={{
              padding: '5px 10px', borderRadius: '999px', fontSize: '12px', cursor: 'pointer',
              border: `1px solid ${filter === id ? '#6c63ff' : '#333'}`,
              background: filter === id ? 'rgba(108,99,255,0.15)' : 'transparent',
              color: filter === id ? '#c9c5ff' : '#999',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p style={{ color: '#e84057', fontSize: '12px', margin: '0 0 8px' }}>{error}</p>}
      {shown.length === 0 ? (
        <p style={{ color: '#777', margin: '16px 0', textAlign: 'center' }}>No reports yet.</p>
      ) : (
        shown.map((r) => (
          <div key={r.id} style={{ background: '#252525', borderRadius: '8px', padding: '10px 12px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <span style={{ fontSize: '12px', color: '#999', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.kind === 'suggestion' ? '💡' : '🐞'}{' '}
                <a href={`mailto:${r.email}?subject=${encodeURIComponent('Re: your Koldrop ' + (r.kind === 'suggestion' ? 'suggestion' : 'bug report'))}`} style={{ color: '#c9c5ff', textDecoration: 'none' }}>
                  {r.email || 'unknown'}
                </a>
                {' · '}
                {new Date(r.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
              <button
                onClick={() => remove(r.id)}
                disabled={deleting === r.id}
                title="Delete"
                style={{ background: 'none', border: 'none', color: '#e84057', cursor: 'pointer', fontSize: '13px', flexShrink: 0, opacity: deleting === r.id ? 0.4 : 1 }}
              >
                🗑 Delete
              </button>
            </div>
            <div style={{ color: '#ddd', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.message}</div>
          </div>
        ))
      )}
    </div>
  );
}
