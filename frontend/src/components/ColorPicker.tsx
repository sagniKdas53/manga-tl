import React, { useState, useRef } from "react";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Box from "@mui/material/Box";
import ColorizeIcon from "@mui/icons-material/Colorize";

// Convert hex to HSVA
const hexToHsva = (hex: string): { h: number; s: number; v: number; a: number } => {
  let clean = hex.trim().replace(/^#/, "");
  if (clean === "transparent" || clean === "") {
    return { h: 0, s: 0, v: 100, a: 0 }; 
  }
  if (clean.length === 3 || clean.length === 4) {
    clean = clean
      .split("")
      .map((c) => c + c)
      .join("");
  }
  let a = 1;
  if (clean.length === 8) {
    a = parseInt(clean.substring(6, 8), 16) / 255;
  } else if (clean.length !== 6) {
    return { h: 0, s: 0, v: 100, a: 1 };
  }
  
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) {
      h = ((g - b) / d) % 6;
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : Math.round((d / max) * 100);
  const v = Math.round(max * 100);

  return { h, s, v, a };
};

// Convert HSVA to Hex
const hsvaToHex = (h: number, s: number, v: number, a: number): string => {
  s /= 100;
  v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r = 0, g = 0, b = 0;
  if (h >= 0 && h < 60) {
    r = c; g = x; b = 0;
  } else if (h >= 60 && h < 120) {
    r = x; g = c; b = 0;
  } else if (h >= 120 && h < 180) {
    r = 0; g = c; b = x;
  } else if (h >= 180 && h < 240) {
    r = 0; g = x; b = c;
  } else if (h >= 240 && h < 300) {
    r = x; g = 0; b = c;
  } else if (h >= 300 && h <= 360) {
    r = c; g = 0; b = x;
  }

  const rHex = Math.round((r + m) * 255).toString(16).padStart(2, "0");
  const gHex = Math.round((g + m) * 255).toString(16).padStart(2, "0");
  const bHex = Math.round((b + m) * 255).toString(16).padStart(2, "0");
  const aHex = Math.round(a * 255).toString(16).padStart(2, "0");

  return a === 1 ? `#${rHex}${gHex}${bHex}` : `#${rHex}${gHex}${bHex}${aHex}`;
};

// Normalize typed HEX string to valid 6/8-character string for display helper
const normalizeHexInput = (val: string): string => {
  const clean = val.trim();
  if (clean === "") return "";
  if (clean === "transparent") return "transparent";
  if (!clean.startsWith("#") && (clean.length === 3 || clean.length === 4 || clean.length === 6 || clean.length === 8)) {
    return "#" + clean;
  }
  return clean;
};

interface ColorPickerProps {
  value: string | null | undefined;
  onChange: (newValue: string | null) => void;
  onLaunchEyeDropper: () => void;
  label: string;
  allowTransparent?: boolean;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  value,
  onChange,
  onLaunchEyeDropper,
  label,
  allowTransparent = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);
  const alphaRef = useRef<HTMLDivElement | null>(null);

  const normalizedValue = value || "";
  const { h, s, v, a } = hexToHsva(normalizedValue);

  const handleSvMouseDown = (
    e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    const updateSv = (clientX: number, clientY: number) => {
      if (!svRef.current) return;
      const rect = svRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
      const newS = Math.round((x / rect.width) * 100);
      const newV = Math.round((1 - y / rect.height) * 100);
      const newHex = hsvaToHex(h, newS, newV, a);
      onChange(newHex);
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      updateSv(moveEvent.clientX, moveEvent.clientY);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    const handleTouchMove = (moveEvent: TouchEvent) => {
      if (moveEvent.touches[0]) {
        updateSv(moveEvent.touches[0].clientX, moveEvent.touches[0].clientY);
      }
    };

    const handleTouchUp = () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchUp);
    };

    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    updateSv(clientX, clientY);

    if ("touches" in e) {
      window.addEventListener("touchmove", handleTouchMove);
      window.addEventListener("touchend", handleTouchUp);
    } else {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
  };

  const handleHueMouseDown = (
    e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    const updateHue = (clientX: number) => {
      if (!hueRef.current) return;
      const rect = hueRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const newH = Math.round((x / rect.width) * 360);
      const newHex = hsvaToHex(newH, s, v, a);
      onChange(newHex);
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      updateHue(moveEvent.clientX);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    const handleTouchMove = (moveEvent: TouchEvent) => {
      if (moveEvent.touches[0]) {
        updateHue(moveEvent.touches[0].clientX);
      }
    };

    const handleTouchUp = () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchUp);
    };

    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    updateHue(clientX);

    if ("touches" in e) {
      window.addEventListener("touchmove", handleTouchMove);
      window.addEventListener("touchend", handleTouchUp);
    } else {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
  };

  const handleAlphaMouseDown = (
    e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    const updateAlpha = (clientX: number) => {
      if (!alphaRef.current) return;
      const rect = alphaRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const newA = x / rect.width;
      const newHex = hsvaToHex(h, s, v, newA);
      onChange(newHex);
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      updateAlpha(moveEvent.clientX);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    const handleTouchMove = (moveEvent: TouchEvent) => {
      if (moveEvent.touches[0]) {
        updateAlpha(moveEvent.touches[0].clientX);
      }
    };

    const handleTouchUp = () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchUp);
    };

    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    updateAlpha(clientX);

    if ("touches" in e) {
      window.addEventListener("touchmove", handleTouchMove);
      window.addEventListener("touchend", handleTouchUp);
    } else {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
  };

  const PRESETS = [
    ...(allowTransparent
      ? [{ label: "Ø", value: "", color: "transparent", title: "Transparent" }]
      : []),
    { label: "W", value: "#ffffff", color: "#ffffff", title: "White" },
    { label: "K", value: "#000000", color: "#000000", title: "Black" },
    { label: "R", value: "#ef4444", color: "#ef4444", title: "Red" },
    { label: "B", value: "#3b82f6", color: "#3b82f6", title: "Blue" },
    { label: "G", value: "#10b981", color: "#10b981", title: "Green" },
    { label: "Y", value: "#f59e0b", color: "#f59e0b", title: "Yellow" },
  ];

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        position: "relative",
      }}
    >
      <Box
        component="label"
        sx={{
          fontSize: "11px",
          fontWeight: "bold",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </Box>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
        {/* Color Badge/Trigger */}
        <Box
          component="button"
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          sx={{
            width: "40px",
            height: "38px",
            padding: "2px",
            border: "1px solid var(--border-color)",
            borderRadius: "6px",
            backgroundColor:
              normalizedValue === "transparent" || normalizedValue === ""
                ? "transparent"
                : normalizedValue,
            cursor: "pointer",
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
            backgroundImage:
              normalizedValue === "transparent" || normalizedValue === "" || a < 1
                ? "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)"
                : "none",
            backgroundSize: "8px 8px",
            backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0px",
            "&::after": {
               content: '""',
               position: "absolute",
               inset: 0,
               backgroundColor: normalizedValue === "transparent" || normalizedValue === "" ? "transparent" : normalizedValue,
            }
          }}
          title="Open Color Wheel / Palette"
        >
          {(normalizedValue === "transparent" || normalizedValue === "") && (
            <Box
              sx={{
                width: "100%",
                height: "2px",
                backgroundColor: "#ef4444",
                transform: "rotate(45deg)",
                zIndex: 1,
              }}
            />
          )}
        </Box>

        {/* Text Input */}
        <TextField
          size="small"
          fullWidth
          placeholder={allowTransparent ? "transparent" : "#ffffff"}
          value={normalizedValue}
          onChange={(e) => {
            const val = e.target.value;
            onChange(val === "" ? null : normalizeHexInput(val));
          }}
        />

        {/* Eye Dropper Button */}
        <IconButton
          size="small"
          onClick={onLaunchEyeDropper}
          title="Eye dropper"
        >
          <ColorizeIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Dropdown Popover */}
      {isOpen && (
        <>
          {/* Backdrop overlay to close picker on click outside */}
          <Box
            onClick={() => setIsOpen(false)}
            sx={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 998,
              cursor: "default",
            }}
          />

          {/* Color Wheel Popover Box */}
          <Box
            sx={{
              position: "absolute",
              top: "46px",
              left: 0,
              zIndex: 999,
              width: "190px",
              padding: "10px",
              backgroundColor: "var(--bg-surface)",
              border: "1px solid var(--border-color)",
              borderRadius: "8px",
              boxShadow: "0 8px 30px rgba(0, 0, 0, 0.4)",
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {/* Saturation / Brightness SV Square */}
            <div
              ref={svRef}
              data-testid="sv-picker"
              onMouseDown={handleSvMouseDown}
              onTouchStart={handleSvMouseDown}
              style={{
                position: "relative",
                width: "100%",
                height: "110px",
                backgroundColor: `hsl(${h}, 100%, 50%)`,
                borderRadius: "4px",
                cursor: "crosshair",
                userSelect: "none",
                overflow: "hidden",
              }}
            >
              {/* White overlay */}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: "linear-gradient(to right, #fff, transparent)",
                }}
              />
              {/* Black overlay */}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: "linear-gradient(to top, #000, transparent)",
                }}
              />
              {/* Target Pointer Handle */}
              <div
                style={{
                  position: "absolute",
                  left: `${s}%`,
                  top: `${100 - v}%`,
                  width: "10px",
                  height: "10px",
                  borderRadius: "50%",
                  border: "1.5px solid #fff",
                  boxShadow: "0 0 3px rgba(0,0,0,0.5)",
                  transform: "translate(-5px, -5px)",
                  pointerEvents: "none",
                  backgroundColor: hsvaToHex(h, s, v, 1),
                }}
              />
            </div>

            {/* Rainbow Hue Slider Bar */}
            <div
              ref={hueRef}
              data-testid="hue-slider"
              onMouseDown={handleHueMouseDown}
              onTouchStart={handleHueMouseDown}
              style={{
                position: "relative",
                width: "100%",
                height: "12px",
                background:
                  "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)",
                borderRadius: "6px",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              {/* Hue slider handle */}
              <div
                style={{
                  position: "absolute",
                  left: `${(h / 360) * 100}%`,
                  top: "50%",
                  width: "12px",
                  height: "12px",
                  borderRadius: "50%",
                  border: "1.5px solid #fff",
                  boxShadow: "0 0 2px rgba(0,0,0,0.5)",
                  transform: "translate(-6px, -50%)",
                  pointerEvents: "none",
                  backgroundColor: `hsl(${h}, 100%, 50%)`,
                }}
              />
            </div>
            
            {/* Alpha Slider Bar */}
            <div
              ref={alphaRef}
              data-testid="alpha-slider"
              onMouseDown={handleAlphaMouseDown}
              onTouchStart={handleAlphaMouseDown}
              style={{
                position: "relative",
                width: "100%",
                height: "12px",
                backgroundImage: "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)",
                backgroundSize: "6px 6px",
                backgroundPosition: "0 0, 0 3px, 3px -3px, -3px 0px",
                borderRadius: "6px",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <div style={{
                position: "absolute",
                top: 0, left: 0, right: 0, bottom: 0,
                borderRadius: "6px",
                background: `linear-gradient(to right, transparent, ${hsvaToHex(h, s, v, 1)})`
              }} />
              {/* Alpha slider handle */}
              <div
                style={{
                  position: "absolute",
                  left: `${a * 100}%`,
                  top: "50%",
                  width: "12px",
                  height: "12px",
                  borderRadius: "50%",
                  border: "1.5px solid #fff",
                  boxShadow: "0 0 2px rgba(0,0,0,0.5)",
                  transform: "translate(-6px, -50%)",
                  pointerEvents: "none",
                  backgroundColor: hsvaToHex(h, s, v, a),
                }}
              />
            </div>

            {/* Presets & Swatches Section */}
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
                marginTop: "4px",
              }}
            >
              {PRESETS.map((p, idx) => (
                <Box
                  component="button"
                  key={idx}
                  type="button"
                  title={p.title}
                  onClick={() => {
                    onChange(p.value === "" ? null : p.value);
                  }}
                  sx={{
                    width: "20px",
                    height: "20px",
                    borderRadius: "4px",
                    border: "1px solid var(--border-color)",
                    cursor: "pointer",
                    backgroundColor: p.color,
                    position: "relative",
                    overflow: "hidden",
                    backgroundImage:
                      p.color === "transparent"
                        ? "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)"
                        : "none",
                    backgroundSize: "6px 6px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {p.color === "transparent" && (
                    <Box
                      sx={{
                        width: "100%",
                        height: "1.5px",
                        backgroundColor: "#ef4444",
                        transform: "rotate(45deg)",
                      }}
                    />
                  )}
                </Box>
              ))}
            </Box>
          </Box>
        </>
      )}
    </Box>
  );
};
