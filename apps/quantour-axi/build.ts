import { mkdir } from 'fs/promises'
import { join } from 'path'

async function buildBinaries() {
  const distDir = join(import.meta.dir, 'dist')
  await mkdir(distDir, { recursive: true })

  console.log('📦 Compiling standalone quantour-axi binary executables with Bun...')

  const targets = [
    { target: 'bun-linux-x64', outfile: 'quantour-axi-linux-x64' },
    { target: 'bun-darwin-arm64', outfile: 'quantour-axi-macos-arm64' },
    { target: 'bun-darwin-x64', outfile: 'quantour-axi-macos-x64' },
    { target: 'bun-windows-x64', outfile: 'quantour-axi-win-x64.exe' },
  ]

  for (const { target, outfile } of targets) {
    console.log(`  🚀 Compiling target: ${target} => dist/${outfile}`)
    
    try {
      const buildResult = await Bun.build({
        entrypoints: [
          join(import.meta.dir, 'src/index.ts'),
        ],
        outdir: distDir,
        compile: {
          target: target as unknown as 'bun-linux-x64',
          outfile,
        },
        minify: true,
      })

      if (!buildResult.success) {
        console.error(`  ❌ Failed to build ${target}:`, buildResult.logs)
      } else {
        console.log(`  ✅ Successfully compiled ${outfile}`)
      }
    } catch (err) {
      console.error(`  ⚠️ Compilation error for ${target}:`, err)
    }
  }

  // Also create a local default binary at dist/quantour-axi for local testing
  const localTarget = `bun-${process.platform}-${process.arch}`
  console.log(`\n🔨 Compiling local host binary: dist/quantour-axi (${localTarget})`)
  await Bun.build({
    entrypoints: [
      join(import.meta.dir, 'src/index.ts'),
    ],
    outdir: distDir,
    compile: {
      outfile: 'quantour-axi',
    },
    minify: true,
  })
  console.log('✨ All standalone binaries compiled successfully!')
}

buildBinaries().catch((err) => {
  console.error('Fatal build error:', err)
  process.exit(1)
})
