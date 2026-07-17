import type {} from "@mui/material/styles";
import type {} from "@mui/material/Button";

declare module "@mui/material/styles" {
  interface Palette {
    conversation: Palette["primary"];
  }
  interface PaletteOptions {
    conversation?: PaletteOptions["primary"];
  }
}

declare module "@mui/material/Button" {
  interface ButtonPropsColorOverrides {
    conversation: true;
  }
}
