import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: { buffer: 'buffer/' },
	},
	define: { global: 'globalThis' },
	optimizeDeps: { include: ['buffer'] },
});
