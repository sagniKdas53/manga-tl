const fs = require('fs');

const file = 'frontend/src/components/SeriesDetails.tsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Imports
content = content.replace(
  'import { safeFetch, toSlug } from "../utils";\nimport ConfirmModal from "./ConfirmModal";',
  'import { safeFetch, toSlug } from "../utils";\nimport ConfirmModal from "./ConfirmModal";\nimport SeriesDialog from "./SeriesDialog";\nimport ChapterDialog from "./ChapterDialog";\nimport ImportChapterDialog from "./ImportChapterDialog";'
);

// 2. State variables
content = content.replace(
  /\/\/ Local states for series edit modal([\s\S]*?)const \[isImporting, setIsImporting\] = useState\(false\);/,
  `// Local states for modals
  const [showSeriesModal, setShowSeriesModal] = useState(false);
  
  const [showChapterModal, setShowChapterModal] = useState(false);
  const [editingChapter, setEditingChapter] = useState<Chapter | null>(null);
  
  const [showImportModal, setShowImportModal] = useState(false);`
);

// 3. Remove useEffect for settings
content = content.replace(
  /React\.useEffect\(\(\) => \{\n\s*if \(\(showSeriesModal \|\| showChapterModal \|\| showImportModal\) && !settings\) \{[\s\S]*?user\.token,\n  \]\);/,
  ``
);

// 4. Handlers 
content = content.replace(
  /\/\/ --- SERIES ACTIONS ---([\s\S]*?)const handleDeleteSeries = \(e: React\.MouseEvent\) => \{/,
  `const nextChapterNum = chapters.reduce(
    (max, c) => (c.chapterNumber > max ? c.chapterNumber : max),
    0,
  ) + 1;

  // --- SERIES ACTIONS ---
  const handleEditSeriesClick = () => {
    setShowSeriesModal(true);
  };

  const handleSeriesSuccess = (data: Series) => {
    setSelectedSeries(data);
    setShowSeriesModal(false);
  };

  const handleDeleteSeries = (e: React.MouseEvent) => {`
);

content = content.replace(
  /\/\/ --- CHAPTER ACTIONS ---([\s\S]*?)return \(/,
  `// --- CHAPTER ACTIONS ---
  const handleEditChapterClick = (c: Chapter, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChapter(c);
    setShowChapterModal(true);
  };

  const handleNewChapterClick = () => {
    setEditingChapter(null);
    setShowChapterModal(true);
  };

  const handleImportChapterClick = () => {
    setShowImportModal(true);
  };

  const handleChapterSuccess = (data: Chapter, isEdit: boolean) => {
    if (isEdit) {
      setChapters((prev) => prev.map((c) => (c.id === data.id ? data : c)));
    } else {
      setChapters((prev) => [...prev, data]);
    }
    setShowChapterModal(false);
    setEditingChapter(null);
  };

  const handleImportSuccess = (data: Chapter) => {
    setChapters((prev) => [...prev, data]);
    setShowImportModal(false);
  };

  return (`
);

// 5. Render Modal blocks
content = content.replace(
  /\{showSeriesModal && \([\s\S]*?\{showImportModal && \([\s\S]*?\)\}\n\s*<ConfirmModal/,
  `<SeriesDialog
        isOpen={showSeriesModal}
        editingSeries={selectedSeries}
        onClose={() => setShowSeriesModal(false)}
        onSuccess={handleSeriesSuccess}
        token={user.token}
      />
      
      <ChapterDialog
        isOpen={showChapterModal}
        editingChapter={editingChapter}
        series={selectedSeries}
        nextChapterNum={nextChapterNum}
        onClose={() => {
          setShowChapterModal(false);
          setEditingChapter(null);
        }}
        onSuccess={handleChapterSuccess}
        token={user.token}
      />
      
      <ImportChapterDialog
        isOpen={showImportModal}
        series={selectedSeries}
        nextChapterNum={nextChapterNum}
        onClose={() => setShowImportModal(false)}
        onSuccess={handleImportSuccess}
        token={user.token}
      />

      <ConfirmModal`
);

fs.writeFileSync(file, content);
console.log('Successfully updated SeriesDetails.tsx');
