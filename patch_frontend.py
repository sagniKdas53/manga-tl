import re

# Patch ChapterHeader.tsx
with open("frontend/src/components/ChapterHeader.tsx", "r") as f:
    header_content = f.read()

# Add props
header_content = header_content.replace(
    "onExportClick: () => void;",
    "onExportClick: () => void;\n  onReexportClick: () => void;\n  onClearExportsClick: () => void;"
)
header_content = header_content.replace(
    "onExportClick,",
    "onExportClick,\n  onReexportClick,\n  onClearExportsClick,"
)

# Add buttons
old_buttons = """                  <Button variant="outlined" startIcon={<DownloadIcon />} onClick={onExportClick}>
                    Export
                  </Button>"""
new_buttons = """                  <Button variant="outlined" startIcon={<DownloadIcon />} onClick={onExportClick}>
                    Export
                  </Button>
                  <Button variant="outlined" color="secondary" onClick={onReexportClick}>
                    Re-export
                  </Button>
                  <Button variant="outlined" color="error" onClick={onClearExportsClick}>
                    Clear Exports
                  </Button>"""
header_content = header_content.replace(old_buttons, new_buttons)

with open("frontend/src/components/ChapterHeader.tsx", "w") as f:
    f.write(header_content)

# Patch ChapterGallery.tsx
with open("frontend/src/components/ChapterGallery.tsx", "r") as f:
    gallery_content = f.read()

# Add handleReexportChapterZip
handle_reexport = """
  const handleReexportChapterZip = useCallback(async () => {
    if (!selectedChapter) return;
    try {
      const res = await safeFetch(
        `/api/series/chapters/${selectedChapter.id}/export?format=zip&force=true`,
        {
          headers: { Authorization: `Bearer ${user.token}` },
        },
      );

      if (!res.ok) {
        throw new Error("Failed to export chapter zip");
      }

      const contentType = res.headers.get("content-type");
      if (
        res.status === 202 ||
        (contentType && contentType.includes("application/json"))
      ) {
        const data = await res.json();
        showToast(
          data.message ||
          "Export started in the background. You will be notified when it is ready.",
          "info",
        );
        return;
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chapter-${selectedChapter.chapterNumber}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      showToast("Error exporting chapter", "error");
    }
  }, [selectedChapter, user.token, showToast]);
"""
gallery_content = gallery_content.replace(
    "const handleExportChapterZip = useCallback(async () => {",
    handle_reexport + "\n  const handleExportChapterZip = useCallback(async () => {"
)

# Add handleClearExports
handle_clear = """
  const handleClearExports = useCallback(async () => {
    if (!selectedChapter) return;
    setConfirmModal({
      isOpen: true,
      title: "Clear Exports",
      message: "Are you sure you want to clear all exports for this chapter?",
      confirmText: "Clear Exports",
      isDangerous: true,
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await safeFetch(
            `/api/series/chapters/${selectedChapter.id}/exports`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${user.token}` },
            },
          );
          if (res.ok) {
            showToast("Cleared chapter exports successfully", "success");
          } else {
            showToast("Failed to clear exports", "error");
          }
        } catch (error) {
          console.error(error);
          showToast("Error clearing exports", "error");
        }
      },
    });
  }, [selectedChapter, user.token, showToast, setConfirmModal]);
"""
gallery_content = gallery_content.replace(
    "const handleExportChapterZip = useCallback(async () => {",
    handle_clear + "\n  const handleExportChapterZip = useCallback(async () => {"
)

# Pass props
gallery_content = gallery_content.replace(
    "onExportClick={handleExportChapterZip}",
    "onExportClick={handleExportChapterZip}\n        onReexportClick={handleReexportChapterZip}\n        onClearExportsClick={handleClearExports}"
)

with open("frontend/src/components/ChapterGallery.tsx", "w") as f:
    f.write(gallery_content)
