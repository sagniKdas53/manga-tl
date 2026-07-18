const fs = require('fs');

const readerFile = 'frontend/src/components/Reader.tsx';
let content = fs.readFileSync(readerFile, 'utf8');

// Find the start of the right sidebar
const startIndex = content.indexOf('<div className="reader-right-sidebar-nhentai">');
// Find the end by counting brackets or just looking for the end of the sidebar
// The right sidebar ends right before:
//       {/* Confirm Modal */}
const endIndex = content.indexOf('{/* Confirm Modal */}');
if (startIndex === -1 || endIndex === -1) {
    console.error("Could not find boundaries");
    process.exit(1);
}

// Extract the JSX
let rightSidebarJSX = content.substring(startIndex, endIndex);
// Remove the trailing '        )}' and '      </div>' before Confirm Modal
const lastDivClose = rightSidebarJSX.lastIndexOf('</div>');
rightSidebarJSX = rightSidebarJSX.substring(0, lastDivClose);
const lastClosingBrace = rightSidebarJSX.lastIndexOf(')}');
rightSidebarJSX = rightSidebarJSX.substring(0, lastClosingBrace);


// Build ReaderRightSidebar.tsx
const rightSidebarContent = `import React from 'react';
import {
  Box,
  Typography,
  IconButton,
  Button,
  CircularProgress,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Checkbox,
  FormControlLabel,
  Divider,
} from "@mui/material";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import AddIcon from "@mui/icons-material/Add";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import ColorizeIcon from "@mui/icons-material/Colorize";
import RefreshIcon from "@mui/icons-material/Refresh";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import UndoIcon from "@mui/icons-material/Undo";
import OpenWithIcon from "@mui/icons-material/OpenWith";
import CropIcon from "@mui/icons-material/Crop";
import ColorPicker from "./ColorPicker"; // Assuming it exists

// Assuming types are defined here or imported
// You may need to adjust types based on actual project structure
export interface ReaderRightSidebarProps {
  selectedItem: any;
  setSelectedItem: (item: any) => void;
  activeLayerId: string | null;
  setActiveLayerId: (id: string | null) => void;
  sortedLayers: any[];
  layers: any[];
  manuallyShownOcrLayers: Set<string>;
  cleanScanlationView: boolean;
  handleMoveLayer: (id: string, direction: "up" | "down") => void;
  handleCreateTranslationLayer: () => void;
  handleCreateSfxLayer: () => void;
  handleToggleLayerVisibility: (id: string) => void;
  handleCloneLayer: (id: string) => void;
  handleDeleteLayer: (id: string) => void;
  handleAddNewElement: (type: "text" | "mask") => void;
  handleLaunchEyeDropper: (field: string) => void;
  handleRedoPageOcr: () => void;
  isRedoingPageOcr: boolean;
  handleRedoPageTranslation: () => void;
  isRedoingPageTranslation: boolean;
  handleExportPng: () => void;
  handleExportZip: () => void;
  interactionMode: string;
  setInteractionMode: React.Dispatch<React.SetStateAction<"none" | "drag" | "reshape">>;
  undoStack: any[];
  handleUndo: () => void;
  handleEnterReshapeMode: (element: any) => void;
  handleUpdateSelectedElement: (updates: any) => void;
  dirtyElements: Set<string>;
  handleSaveElementChanges: (element: any) => void;
  handleDeleteElement: (id: string) => void;
  ocrRegions: any[];
  isRedoingRegionOcr: boolean;
  handleRedoRegion: (region: any, type: "ocr" | "translation") => void;
  isRedoingRegionTl: boolean;
}

const ReaderRightSidebar: React.FC<ReaderRightSidebarProps> = (props) => {
  const {
    selectedItem, setSelectedItem,
    activeLayerId, setActiveLayerId,
    sortedLayers, layers, manuallyShownOcrLayers, cleanScanlationView,
    handleMoveLayer, handleCreateTranslationLayer, handleCreateSfxLayer,
    handleToggleLayerVisibility, handleCloneLayer, handleDeleteLayer,
    handleAddNewElement, handleLaunchEyeDropper,
    handleRedoPageOcr, isRedoingPageOcr,
    handleRedoPageTranslation, isRedoingPageTranslation,
    handleExportPng, handleExportZip,
    interactionMode, setInteractionMode, undoStack, handleUndo, handleEnterReshapeMode,
    handleUpdateSelectedElement, dirtyElements, handleSaveElementChanges, handleDeleteElement,
    ocrRegions, isRedoingRegionOcr, handleRedoRegion, isRedoingRegionTl
  } = props;

  return (
${rightSidebarJSX.trim()}
  );
};

export default React.memo(ReaderRightSidebar);
`;

fs.writeFileSync('frontend/src/components/ReaderRightSidebar.tsx', rightSidebarContent);

// Replace the extracted JSX with the Component usage in Reader.tsx
const leftSidebarIndex = content.indexOf('<div className="reader-left-sidebar-nhentai">');
const rightSidebarEndIndex = content.indexOf('{/* Confirm Modal */}');
const workspaceEndIndex = content.lastIndexOf('</div>', rightSidebarEndIndex);

const beforeWorkspace = content.substring(0, leftSidebarIndex);
const afterWorkspace = content.substring(rightSidebarEndIndex);

const newWorkspaceContent = `
          {showLeftSidebar && (
            <ReaderLeftSidebar
              showPanels={showPanels}
              setShowPanels={setShowPanels}
              showOcr={showOcr}
              setShowOcr={setShowOcr}
              cleanScanlationView={cleanScanlationView}
              setCleanScanlationView={setCleanScanlationView}
              setManuallyShownOcrLayers={setManuallyShownOcrLayers}
              groupByConversation={groupByConversation}
              setGroupByConversation={setGroupByConversation}
              zoom={zoom}
              setZoom={setZoom}
              fitMode={fitMode}
              setFitMode={setFitMode}
              curPageNum={selectedPage?.pageNumber || 0}
              totalPages={pages.length}
              navigateToPage={(pageNum) => {
                const targetPage = pages.find((p) => p.pageNumber === pageNum);
                if (targetPage) {
                  navigate(
                    \`/chapters/\${selectedChapter?.id}/\${toSlug(selectedChapter?.title || "chapter")}/pages/\${targetPage.id}\`
                  );
                }
              }}
              prevChapter={prevChapter}
              nextChapter={nextChapter}
              navigateToChapter={(chapter) => {
                navigate(\`/chapters/\${chapter.id}/\${toSlug(chapter.title || "chapter")}\`);
              }}
              selectedPage={selectedPage}
              handleDeletePage={handleDeletePage}
              handleChangePageNumber={handleChangePageNumber}
            />
          )}

          {/* Reader Center Canvas (Image & Layers) */}
          <div className="reader-canvas-container-nhentai" ref={canvasContainerRef}>
${content.substring(content.indexOf('{/* Image Container */}'), startIndex)}
          </div>

          {/* Right Sidebar */}
          {showRightSidebar && (
            <ReaderRightSidebar
              selectedItem={selectedItem}
              setSelectedItem={setSelectedItem}
              activeLayerId={activeLayerId}
              setActiveLayerId={setActiveLayerId}
              sortedLayers={sortedLayers}
              layers={layers}
              manuallyShownOcrLayers={manuallyShownOcrLayers}
              cleanScanlationView={cleanScanlationView}
              handleMoveLayer={handleMoveLayer}
              handleCreateTranslationLayer={handleCreateTranslationLayer}
              handleCreateSfxLayer={handleCreateSfxLayer}
              handleToggleLayerVisibility={handleToggleLayerVisibility}
              handleCloneLayer={handleCloneLayer}
              handleDeleteLayer={handleDeleteLayer}
              handleAddNewElement={handleAddNewElement}
              handleLaunchEyeDropper={handleLaunchEyeDropper}
              handleRedoPageOcr={handleRedoPageOcr}
              isRedoingPageOcr={isRedoingPageOcr}
              handleRedoPageTranslation={handleRedoPageTranslation}
              isRedoingPageTranslation={isRedoingPageTranslation}
              handleExportPng={handleExportPng}
              handleExportZip={handleExportZip}
              interactionMode={interactionMode}
              setInteractionMode={setInteractionMode}
              undoStack={undoStack}
              handleUndo={handleUndo}
              handleEnterReshapeMode={handleEnterReshapeMode}
              handleUpdateSelectedElement={handleUpdateSelectedElement}
              dirtyElements={dirtyElements}
              handleSaveElementChanges={handleSaveElementChanges}
              handleDeleteElement={handleDeleteElement}
              ocrRegions={ocrRegions}
              isRedoingRegionOcr={isRedoingRegionOcr}
              handleRedoRegion={handleRedoRegion}
              isRedoingRegionTl={isRedoingRegionTl}
            />
          )}
        `;

fs.writeFileSync('frontend/src/components/Reader.tsx', beforeWorkspace + newWorkspaceContent + afterWorkspace);
console.log("Successfully extracted ReaderRightSidebar.tsx and updated Reader.tsx");
