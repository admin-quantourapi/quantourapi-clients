import type { Config } from '@react-router/dev/config'

export default {
  // Config options...
  // Server-side render by default, to get data in loaders
  ssr: true,
  allowedActionOrigins: [
    'stocks.home',
    '*.home',
    '**.home',
    'localhost:3000',
    'localhost:3001',
    '127.0.0.1:3000',
    '127.0.0.1:3001',
  ],
} satisfies Config

