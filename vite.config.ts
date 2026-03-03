import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import viteLogPlugin from './plugins/viteLogPlugin.js'

export default defineConfig({
  plugins: [react(), viteLogPlugin()],
})
