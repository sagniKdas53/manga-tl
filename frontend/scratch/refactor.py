import re

with open('/home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/SeriesDetails.tsx', 'r') as f:
    content = f.read()

# 1. Imports
content = content.replace('import ConfirmModal from "./ConfirmModal";', 'import ConfirmModal from "./ConfirmModal";\nimport SeriesDialog from "./SeriesDialog";\nimport ChapterDialog from "./ChapterDialog";\nimport ImportChapterDialog from "./ImportChapterDialog";')

# 2. State variables block
state_pattern = re.compile(r'  // Local states for series edit modal.*?const \[isImporting, setIsImporting\] = useState\(false\);', re.DOTALL)
replacement_state = """  const [showSeriesModal, setShowSeriesModal] = useState(false);
  
  const [showChapterModal, setShowChapterModal] = useState(false);
  const [editingChapter, setEditingChapter] = useState<Chapter | null>(null);
  const [chapterError, setChapterError] = useState("");
  
  const { showToast } = useToast();
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);

  const [showImportModal, setShowImportModal] = useState(false);
  const [importError, setImportError] = useState("");
  const [isImporting, setIsImporting] = useState(false);"""
content = state_pattern.sub(replacement_state, content)

# 3. Handlers
handlers_pattern = re.compile(r'  // --- SERIES ACTIONS ---.*?const handleDeleteChapter', re.DOTALL)
replacement_handlers = """  // --- SERIES ACTIONS ---
  const handleEditSeriesClick = () => {
    setShowSeriesModal(true);
  };

  const handleSaveSeries = async (data: any) => {
    try {
      const res = await safeFetch(`/api/series/${selectedSeries.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const updated: Series = await res.json();
        setSelectedSeries(updated);
        setShowSeriesModal(false);
      }
    } catch (err) {
      console.error("Error updating series:", err);
    }
  };

  const handleDeleteSeries = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmModal({
      isOpen: true,
      title: "Delete Series",
      message:
        "Are you sure you want to delete this series? This will delete all chapters and pages!",
      confirmText: "Delete Series",
      isDangerous: true,
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await safeFetch(`/api/series/${selectedSeries.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${user.token}` },
          });
          if (res.ok) {
            setSelectedSeries(null);
            navigate("/");
            showToast("Series deleted successfully", "success");
          } else if (res.status === 403) {
            showToast("You don't have permission to delete this series.", "error");
          } else {
            showToast("Failed to delete series", "error");
          }
        } catch (err) {
          console.error("Error deleting series:", err);
          showToast("Error deleting series", "error");
        }
      },
    });
  };

  // --- CHAPTER ACTIONS ---
  const handleEditChapterClick = (c: Chapter, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChapter(c);
    setChapterError("");
    setShowChapterModal(true);
  };

  const handleNewChapterClick = () => {
    setEditingChapter(null);
    setChapterError("");
    setShowChapterModal(true);
  };

  const handleImportChapterClick = () => {
    setImportError("");
    setIsImporting(false);
    setShowImportModal(true);
  };

  const handleImportSubmit = async (formData: FormData) => {
    if (!selectedSeries) return;
    setImportError("");
    setIsImporting(true);

    try {
      const res = await safeFetch(
        `/api/series/${selectedSeries.id}/chapters/import`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${user.token}`,
          },
          body: formData,
        },
      );

      if (res.ok) {
        const data: Chapter = await res.json();
        setChapters((prev) => [...prev, data]);
        setShowImportModal(false);
      } else {
        let errMsg = "Failed to import chapter";
        try {
          const text = await res.text();
          if (text) {
            try {
              const parsed = JSON.parse(text);
              errMsg = parsed.message || parsed.error || errMsg;
            } catch {
              errMsg = text;
            }
          }
        } catch (readErr) {
          console.error(readErr);
        }
        setImportError(errMsg);
      }
    } catch (err) {
      console.error("Error importing chapter:", err);
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsImporting(false);
    }
  };

  const handleSaveChapter = async (data: any) => {
    setChapterError("");
    try {
      const isEdit = !!editingChapter;
      const url = isEdit
        ? `/api/series/chapters/${editingChapter.id}`
        : `/api/series/${selectedSeries.id}/chapters`;
      const method = isEdit ? "PUT" : "POST";

      const res = await safeFetch(url, {
        method: method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const savedData: Chapter = await res.json();
        if (isEdit) {
          setChapters((prev) => prev.map((c) => (c.id === savedData.id ? savedData : c)));
        } else {
          setChapters((prev) => [...prev, savedData]);
        }
        setShowChapterModal(false);
        setEditingChapter(null);
        setChapterError("");
      } else {
        let errMsg = "Failed to save chapter";
        try {
          const text = await res.text();
          if (text) {
            try {
              const parsed = JSON.parse(text);
              errMsg = parsed.message || parsed.error || errMsg;
            } catch {
              errMsg = text;
            }
          }
        } catch (readErr) {
          console.error(readErr);
        }
        setChapterError(errMsg);
      }
    } catch (err) {
      console.error("Error saving chapter:", err);
      setChapterError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteChapter"""
content = handlers_pattern.sub(replacement_handlers, content)

# 4. Modals
modals_pattern = re.compile(r'      \{showSeriesModal && \(.*?      <ConfirmModal', re.DOTALL)
replacement_modals = """      <SeriesDialog
        isOpen={showSeriesModal}
        onClose={() => setShowSeriesModal(false)}
        onSave={handleSaveSeries}
        initialData={selectedSeries}
        settings={settings}
      />

      <ChapterDialog
        isOpen={showChapterModal}
        onClose={() => {
          setShowChapterModal(false);
          setEditingChapter(null);
          setChapterError("");
        }}
        onSave={handleSaveChapter}
        initialData={editingChapter}
        defaultChapterNumber={
          chapters.reduce((max, c) => (c.chapterNumber > max ? c.chapterNumber : max), 0) + 1
        }
        settings={settings}
        error={chapterError}
      />

      <ImportChapterDialog
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImport={handleImportSubmit}
        defaultChapterNumber={
          chapters.reduce((max, c) => (c.chapterNumber > max ? c.chapterNumber : max), 0) + 1
        }
        settings={settings}
        error={importError}
        isImporting={isImporting}
      />

      <ConfirmModal"""
content = modals_pattern.sub(replacement_modals, content)

with open('/home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/SeriesDetails.tsx', 'w') as f:
    f.write(content)
