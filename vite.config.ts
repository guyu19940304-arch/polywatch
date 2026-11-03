import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
export default defineConfig({root:realpathSync(process.cwd()),plugins:[react()],server:{host:'127.0.0.1',port:5173,strictPort:true,proxy:{'/api':'http://127.0.0.1:8787'}},build:{chunkSizeWarningLimit:700}});
