import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ReaderRightSidebar from "./ReaderRightSidebar";

describe("ReaderRightSidebar", () => {
  it("renders correctly with no selection", () => {
    render(
      <ReaderRightSidebar
        selectedItem={null}
        setSelectedItem={vi.fn()}
        activeLayerId={null}
        setActiveLayerId={vi.fn()}
        sortedLayers={[]}
        layers={[]}
        manuallyShownOcrLayers={new Set()}
        cleanScanlationView={false}
        handleMoveLayer={vi.fn()}
        handleCreateTranslationLayer={vi.fn()}
        handleCreateSfxLayer={vi.fn()}
        handleToggleLayerVisibility={vi.fn()}
        handleCloneLayer={vi.fn()}
        handleDeleteLayer={vi.fn()}
        handleAddNewElement={vi.fn()}
        handleLaunchEyeDropper={vi.fn()}
        handleRedoPageOcr={vi.fn()}
        isRedoingPageOcr={false}
        handleRedoPageTranslation={vi.fn()}
        isRedoingPageTranslation={false}
        handleExportPng={vi.fn()}
        handleExportZip={vi.fn()}
        interactionMode="none"
        setInteractionMode={vi.fn()}
        undoStack={[]}
        handleUndo={vi.fn()}
        handleEnterReshapeMode={vi.fn()}
        handleUpdateSelectedElement={vi.fn()}
        dirtyElements={new Set()}
        handleSaveElementChanges={vi.fn()}
        handleDeleteElement={vi.fn()}
        ocrRegions={[]}
        isRedoingRegionOcr={false}
        handleRedoRegionOcr={vi.fn()}
        isRedoingRegionTranslation={false}
        handleRedoRegionTranslation={vi.fn()}
        handleDeleteRegion={vi.fn()}
      />
    );
    expect(
      screen.getByText(
        "Select an OCR region or a text layer to inspect and edit details."
      )
    ).toBeInTheDocument();
  });
});
