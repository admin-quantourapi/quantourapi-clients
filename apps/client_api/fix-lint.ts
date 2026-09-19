import fs from 'fs'

// Fix cronJobs.ts
let cron = fs.readFileSync('src/cronJobs.ts', 'utf-8')
cron = cron.replace(/\} catch \{\}/g, '} catch { /* ignore */ }')
fs.writeFileSync('src/cronJobs.ts', cron)

// Fix telegramService.ts
let tg = fs.readFileSync('src/services/telegramService.ts', 'utf-8')
tg = tg.replace(/} catch \(e\) \{\}/g, '} catch (e) { /* ignore */ }')
tg = tg.replace(/} catch\(e\) \{\}/g, '} catch (e) { /* ignore */ }')
tg = tg.replace(/\} catch \{\}/g, '} catch { /* ignore */ }')

fs.writeFileSync('src/services/telegramService.ts', tg)
console.log('Fixed linting')
