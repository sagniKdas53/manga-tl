import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ColorPicker } from "./ColorPicker";

describe("ColorPicker", () => {
  it("renders with given label and value", () => {
    const onChange = vi.fn();
    const onLaunchEyeDropper = vi.fn();
    render(
      <ColorPicker
        label="Text Color"
        value="#ff0000"
        onChange={onChange}
        onLaunchEyeDropper={onLaunchEyeDropper}
      />
    );
    expect(screen.getByText("Text Color")).toBeInTheDocument();
    const input = screen.getByDisplayValue("#ff0000");
    expect(input).toBeInTheDocument();
  });

  it("calls onChange when input value changes", () => {
    const onChange = vi.fn();
    const onLaunchEyeDropper = vi.fn();
    render(
      <ColorPicker
        label="Text Color"
        value="#000000"
        onChange={onChange}
        onLaunchEyeDropper={onLaunchEyeDropper}
      />
    );
    const input = screen.getByDisplayValue("#000000");
    fireEvent.change(input, { target: { value: "#111111" } });
    expect(onChange).toHaveBeenCalledWith("#111111");
  });

  it("calls onLaunchEyeDropper when eyedropper button is clicked", () => {
    const onChange = vi.fn();
    const onLaunchEyeDropper = vi.fn();
    render(
      <ColorPicker
        label="Text Color"
        value="#000000"
        onChange={onChange}
        onLaunchEyeDropper={onLaunchEyeDropper}
      />
    );
    const button = screen.getByTitle("Color Dropper");
    fireEvent.click(button);
    expect(onLaunchEyeDropper).toHaveBeenCalled();
  });

  it("opens popover and calls onChange when preset is clicked", () => {
    const onChange = vi.fn();
    const onLaunchEyeDropper = vi.fn();
    render(
      <ColorPicker
        label="Text Color"
        value="#000000"
        onChange={onChange}
        onLaunchEyeDropper={onLaunchEyeDropper}
      />
    );
    
    // Popover is initially closed, presets are not visible
    expect(screen.queryByTitle("Red")).not.toBeInTheDocument();

    // Open popover
    const toggle = screen.getByTitle("Open Color Wheel / Palette");
    fireEvent.click(toggle);

    // Click Red preset
    const redPreset = screen.getByTitle("Red");
    fireEvent.click(redPreset);
    expect(onChange).toHaveBeenCalledWith("#ef4444");
  });
});
