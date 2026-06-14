import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { User, Series, Chapter, Page } from '../types';
import { safeFetch, toSlug } from '../utils';

interface ChapterGalleryProps {
  user: User;
  selectedSeries: Series | null;
  selectedChapter: Chapter | null;
  setSelectedChapter: React.Dispatch<React.SetStateAction<Chapter | null>>;
  pages: Page[];
  setPages: React.Dispatch<React.SetStateAction<Page[]>>;
  onSelectPage: (page: Page) => void;
  isLoadingDetails: boolean;
}

export const ChapterGallery: React.FC<ChapterGalleryProps> = ({
  user,
  selectedSeries,
  selectedChapter,
  setSelectedChapter,
  pages,
  setPages,
  onSelectPage,
  isLoadingDetails,
}) => {
  const navigate = useNavigate();
  const [isDragging, setIsDragging] = useState(false);

  if (isLoadingDetails || !selectedSeries || !selectedChapter) {
    return (
      <div className="dashboard-content text-center">
        <div className="spinner"></div>
        <p>Loading chapter details...</p>
      </div>
    );
  }

  const handleDeletePage = async (pageId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this page? This will also delete all associated panels, OCR regions, and translations.')) return;
    try {
      const res = await safeFetch(`/api/pages/${pageId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.ok) {
        // Filter locally
        setPages(prev => prev.filter(p => p.id !== pageId));
        // Re-fetch pages list to verify orders
        const r = await safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
          headers: { 'Authorization': `Bearer ${user.token}` }
        });
        if (r.ok) {
          const data: Page[] = await r.json();
          setPages(data);
        }
      } else {
        alert('Failed to delete page');
      }
    } catch (err) {
      console.error('Error deleting page:', err);
    }
  };

  const handleMovePage = async (index: number, direction: 'left' | 'right') => {
    const newIndex = direction === 'left' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= pages.length) return;

    // Swap locally for instant feedback using splice to avoid dynamic bracket notation lint warning
    const updatedPages = [...pages];
    const [moved] = updatedPages.splice(index, 1);
    updatedPages.splice(newIndex, 0, moved);
    
    // Adjust pageNumbers in the updated array
    const finalPages = updatedPages.map((p, idx) => ({ ...p, pageNumber: idx + 1 }));
    setPages(finalPages);

    try {
      const res = await safeFetch(`/api/chapters/${selectedChapter.id}/pages/reorder`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify(finalPages.map(p => p.id))
      });
      if (!res.ok) {
        throw new Error('Failed to save reorder on backend');
      }
    } catch (err) {
      console.error('Error saving page order:', err);
      // Revert if error
      safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(r => r.json())
      .then(data => setPages(data))
      .catch(fetchErr => console.error('Error reverting page order:', fetchErr));
    }
  };

  const processUploadedFiles = async (files: FileList) => {
    let nextNum = pages.length + 1;
    for (let i = 0; i < files.length; i++) {
      const file = files.item(i); // Fixed: Use files.item(i) instead of files[i] to avoid dynamic bracket warning
      if (!file) continue;
      const formData = new FormData();
      formData.append('chapterId', selectedChapter.id);
      formData.append('pageNumber', nextNum.toString());
      formData.append('file', file);

      try {
        const res = await safeFetch('/api/images', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${user.token}`
          },
          body: formData
        });
        if (res.ok) {
          nextNum++;
          // Re-fetch pages list
          const r = await safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
            headers: { 'Authorization': `Bearer ${user.token}` }
          });
          if (r.ok) {
            const data: Page[] = await r.json();
            setPages(data);
          }
        }
      } catch (err) {
        console.error('Failed to upload page', err);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processUploadedFiles(files);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) processUploadedFiles(files);
  };

  return (
    <div className="dashboard-content">
      <div className="mb-8">
        <button 
          className="btn btn-secondary" 
          onClick={() => {
            setSelectedChapter(null);
            navigate(`/series/${selectedSeries.id}/${toSlug(selectedSeries.title)}`);
          }} 
          style={{ padding: '8px 16px', marginBottom: '16px' }}
        >
          &larr; Back to Series
        </button>
        <div className="page-header">
          <div>
            <h1>Chapter {selectedChapter.chapterNumber}</h1>
            <p style={{ color: 'var(--text-muted)', margin: '8px 0 0' }}>{selectedSeries.title} / {selectedChapter.title || 'Untitled'}</p>
          </div>
          <button 
            className="btn btn-secondary" 
            onClick={() => {
              safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
                headers: { 'Authorization': `Bearer ${user.token}` }
              })
              .then(r => r.json())
              .then(data => setPages(data));
            }}
          >
            Refresh Gallery
          </button>
        </div>
      </div>

      <div 
        className={`upload-dropzone ${isDragging ? 'dragging' : ''}`} 
        onClick={() => document.getElementById('file-upload')?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <svg className="upload-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        <h3 style={{ margin: '0 0 8px' }}>Upload Manga Pages</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Drag and drop multiple images, or click to browse</p>
        <input 
          id="file-upload" 
          type="file" 
          multiple 
          accept="image/*" 
          style={{ display: 'none' }} 
          onChange={handleFileUpload} 
        />
      </div>

      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '22px' }}>Uploaded Pages ({pages.length})</h2>
      <div className="pages-grid">
        {pages.map((p, idx) => (
          <div 
            key={p.id} 
            className="page-thumbnail-container glass" 
            onClick={() => {
              onSelectPage(p);
              navigate(`/chapters/${selectedChapter.id}/${toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`)}/reader/${p.pageNumber}`);
            }}
            style={{ position: 'relative' }}
          >
            <img src={p.url} className="page-thumbnail" alt={`Page ${p.pageNumber}`} />
            <span className="page-num-tag">Page {p.pageNumber}</span>

            <button 
              className="delete-page-btn" 
              onClick={(e) => handleDeletePage(p.id, e)}
              title="Delete page"
            >
              &times;
            </button>

            <div className="reorder-controls" onClick={e => e.stopPropagation()}>
              <button 
                className="reorder-btn"
                onClick={() => handleMovePage(idx, 'left')}
                disabled={idx === 0}
                title="Move page left"
              >
                &larr;
              </button>
              <button 
                className="reorder-btn"
                onClick={() => handleMovePage(idx, 'right')}
                disabled={idx === pages.length - 1}
                title="Move page right"
              >
                &rarr;
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
