import React from "react";

export interface ChapterDragOverlayProps {
  visible: boolean;
  chapterNumber: number;
}

const ChapterDragOverlay: React.FC<ChapterDragOverlayProps> = ({
  visible,
  chapterNumber,
}) => {
  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(15, 15, 25, 0.85)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: "4px dashed rgba(99, 102, 241, 0.6)",
        borderRadius: "16px",
        margin: "16px",
        pointerEvents: "none",
        animation: "fadeIn 0.15s ease-out",
      }}
    >
      <div
        style={{
          background:
            "linear-gradient(145deg, rgba(30,30,50,0.95) 0%, rgba(20,20,38,0.95) 100%)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "20px",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          padding: "40px 60px",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "16px",
        }}
      >
        <div
          style={{
            width: "60px",
            height: "60px",
            borderRadius: "16px",
            background: "rgba(99, 102, 241, 0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            animation: "pulse 2s infinite",
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#818cf8"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line
              x1="12"
              y1="3"
              x2="12"
              y2="15"
            />
          </svg>
        </div>
        <h2
          style={{
            color: "#fff",
            fontSize: "20px",
            fontWeight: 700,
            margin: 0,
          }}
        >
          Drop Manga Pages Anywhere
        </h2>
        <p
          style={{
            color: "rgba(226,232,240,0.7)",
            fontSize: "14px",
            margin: 0,
          }}
        >
          Release to add multiple files to Chapter {chapterNumber}
        </p>
      </div>
    </div>
  );
};

export default React.memo(ChapterDragOverlay);
