import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: frontendRoot,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(frontendRoot, "index.html"),
        settings: resolve(frontendRoot, "settings.html"),
        mindmap: resolve(frontendRoot, "mindmap.html"),
      },
    },
  },
});
