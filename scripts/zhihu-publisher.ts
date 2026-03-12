/**
 * Host-side Zhihu draft publisher using Playwright.
 * Uses a persistent browser context so login state is preserved across runs.
 *
 * Usage: npx tsx scripts/zhihu-publisher.ts --title "标题" --content path/to/file.html [--cover path/to/cover.jpg]
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { marked } from 'marked';
import { chromium } from 'playwright';

const BROWSER_STATE_DIR = path.join(
  process.cwd(),
  'data',
  'zhihu-browser-state',
);

interface PublishResult {
  success: boolean;
  draftUrl?: string;
  error?: string;
}

async function publishToZhihu(
  title: string,
  contentFile: string,
  coverImage?: string,
): Promise<PublishResult> {
  if (!fs.existsSync(contentFile)) {
    return { success: false, error: `Content file not found: ${contentFile}` };
  }

  if (coverImage && !fs.existsSync(coverImage)) {
    console.log(`[zhihu] Warning: Cover image not found: ${coverImage}, skipping`);
    coverImage = undefined;
  }

  const content = fs.readFileSync(contentFile, 'utf-8');

  // Convert content to HTML for rich-text paste into ProseMirror
  let htmlContent: string;
  if (contentFile.endsWith('.md')) {
    // Markdown → HTML via marked
    htmlContent = marked.parse(content, { async: false }) as string;
    console.log('[zhihu] Converted markdown to HTML for rich-text paste');
  } else {
    // Already HTML
    htmlContent = content;
  }

  fs.mkdirSync(BROWSER_STATE_DIR, { recursive: true });

  const browser = await chromium.launchPersistentContext(BROWSER_STATE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = browser.pages()[0] || (await browser.newPage());

  try {
    // Navigate to Zhihu write page
    console.log('[zhihu] Opening write page...');
    await page.goto('https://zhuanlan.zhihu.com/write', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait a moment for dynamic content
    await page.waitForTimeout(3000);

    // Check if we need to login
    const currentUrl = page.url();
    if (currentUrl.includes('signin') || currentUrl.includes('login')) {
      console.log(
        '[zhihu] ERROR: Not logged in. Please run this script manually once to login.',
      );
      console.log('[zhihu] The browser window will stay open for 60 seconds.');
      console.log('[zhihu] Log in manually, then the state will be saved.');
      await page.waitForURL('**/write', { timeout: 60000 }).catch(() => {});
      if (page.url().includes('signin') || page.url().includes('login')) {
        await browser.close();
        return {
          success: false,
          error:
            'Zhihu login required. Run: npx tsx scripts/zhihu-publisher.ts --login',
        };
      }
    }

    console.log('[zhihu] Page loaded, entering title...');

    // Find and fill title
    const titleInput = page.locator(
      'textarea[placeholder*="标题"], input[placeholder*="标题"]',
    );
    await titleInput.waitFor({ timeout: 10000 });
    await titleInput.fill(title);

    console.log('[zhihu] Title entered, pasting HTML content...');

    // Build Windows CF_HTML clipboard format entirely in Node.js (avoids
    // PowerShell string-encoding issues with Chinese text).
    const prefix = '<html><body><!--StartFragment-->';
    const suffix = '<!--EndFragment--></body></html>';
    const headerFmt = (sh: number, eh: number, sf: number, ef: number) =>
      `Version:0.9\r\nStartHTML:${String(sh).padStart(10, '0')}\r\nEndHTML:${String(eh).padStart(10, '0')}\r\nStartFragment:${String(sf).padStart(10, '0')}\r\nEndFragment:${String(ef).padStart(10, '0')}\r\n`;

    const dummyHeader = headerFmt(0, 0, 0, 0);
    const headerLen = Buffer.byteLength(dummyHeader, 'utf-8');
    const startHtml = headerLen;
    const startFrag = headerLen + Buffer.byteLength(prefix, 'utf-8');
    const endFrag = startFrag + Buffer.byteLength(htmlContent, 'utf-8');
    const endHtml = endFrag + Buffer.byteLength(suffix, 'utf-8');
    const cfHtml = headerFmt(startHtml, endHtml, startFrag, endFrag) + prefix + htmlContent + suffix;

    // Write CF_HTML bytes and plain text to temp files
    const dataDir = path.join(process.cwd(), 'data');
    const cfHtmlFile = path.join(dataDir, 'zhihu-cfhtml.bin');
    const plainFile = path.join(dataDir, 'zhihu-plain.txt');
    const plainText = htmlContent.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    fs.writeFileSync(cfHtmlFile, Buffer.from(cfHtml, 'utf-8'));
    fs.writeFileSync(plainFile, plainText, 'utf-16le');  // PowerShell UnicodeText expects UTF-16LE

    // Minimal PowerShell: read raw bytes, set clipboard — no string conversion
    const ps1 = `
Add-Type -AssemblyName System.Windows.Forms
$cfBytes = [System.IO.File]::ReadAllBytes('${cfHtmlFile.replace(/\\/g, '\\\\')}')
$ms = New-Object System.IO.MemoryStream(,$cfBytes)
$plain = [System.IO.File]::ReadAllText('${plainFile.replace(/\\/g, '\\\\')}', [System.Text.Encoding]::Unicode)
$do = New-Object System.Windows.Forms.DataObject
$do.SetData('HTML Format', $ms)
$do.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $plain)
[System.Windows.Forms.Clipboard]::SetDataObject($do, $true)
`;
    const ps1File = path.join(dataDir, 'zhihu-set-clipboard.ps1');
    // Write .ps1 with UTF-8 BOM so PowerShell reads it correctly
    fs.writeFileSync(ps1File, '\ufeff' + ps1, 'utf-8');

    try {
      execSync(
        `powershell -ExecutionPolicy Bypass -NoProfile -STA -File "${ps1File}"`,
        { timeout: 15000 },
      );
      console.log('[zhihu] HTML clipboard set via CF_HTML (bytes built in Node)');
    } finally {
      try { fs.unlinkSync(cfHtmlFile); } catch { /* ignore */ }
      try { fs.unlinkSync(plainFile); } catch { /* ignore */ }
      try { fs.unlinkSync(ps1File); } catch { /* ignore */ }
    }

    // Click editor and paste
    const editor = page.locator(
      '.ProseMirror, [contenteditable="true"], .public-DraftEditor-content',
    );
    await editor.waitFor({ timeout: 10000 });
    await editor.click();
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(3000);

    // Dismiss any modal that may appear after paste
    const modalCheck = page.locator('.Modal-backdrop');
    if (await modalCheck.count() > 0) {
      console.log('[zhihu] Modal detected, dismissing...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    }

    console.log('[zhihu] Content pasted.');

    // Upload cover image if provided
    if (coverImage) {
      console.log(`[zhihu] Uploading cover image: ${coverImage}`);
      const absImagePath = path.resolve(coverImage);
      try {
        let uploaded = false;

        // Zhihu's cover image is in "发布设置" panel at the bottom
        console.log('[zhihu] Opening publish settings...');
        const publishSettings = page.getByText('发布设置', { exact: false });
        if (await publishSettings.count() > 0) {
          await publishSettings.first().click();
          await page.waitForTimeout(2000);

          // Scroll down to make the cover upload area visible
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(1000);

          // The cover area is a dashed box with text "+ 添加文章封面"
          // Click it to trigger the native file chooser
          const coverArea = page.getByText('添加文章封面');
          if (await coverArea.count() > 0) {
            console.log('[zhihu] Found "添加文章封面" area, clicking...');
            try {
              const [fileChooser] = await Promise.all([
                page.waitForEvent('filechooser', { timeout: 15000 }),
                coverArea.first().click(),
              ]);
              await fileChooser.setFiles(absImagePath);
              uploaded = true;
              console.log('[zhihu] Cover image selected via file chooser!');
              // Wait for upload to complete
              await page.waitForTimeout(8000);

              const confirmPath = path.join(process.cwd(), 'groups', 'main', 'logs', 'zhihu-cover-done.png');
              await page.screenshot({ path: confirmPath, fullPage: false });
              console.log(`[zhihu] Confirm screenshot: ${confirmPath}`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.log(`[zhihu] "添加文章封面" click did not trigger file chooser: ${msg}`);
            }
          }

          // Fallback: try clicking the dashed border container itself
          if (!uploaded) {
            console.log('[zhihu] Trying to find the upload container by CSS...');
            // Look for the dashed-border upload container
            const uploadContainers = await page.$$('div[style*="dashed"], div[class*="upload"], div[class*="Upload"]');
            for (const container of uploadContainers) {
              try {
                const text = await container.textContent();
                if (text && text.includes('封面')) {
                  console.log('[zhihu] Found upload container with 封面 text');
                  const [fileChooser] = await Promise.all([
                    page.waitForEvent('filechooser', { timeout: 15000 }),
                    container.click(),
                  ]);
                  await fileChooser.setFiles(absImagePath);
                  uploaded = true;
                  console.log('[zhihu] Cover image uploaded via container click!');
                  await page.waitForTimeout(8000);
                  break;
                }
              } catch {
                // Try next container
              }
            }
          }

          // Fallback: use evaluate to find and click the upload trigger
          if (!uploaded) {
            console.log('[zhihu] Trying JavaScript click approach...');
            try {
              // Find the input[type=file] associated with cover image and dispatch click
              const hasFileInput = await page.evaluate(() => {
                const inputs = document.querySelectorAll('input[type="file"][accept*="image"]');
                if (inputs.length > 0) {
                  (inputs[0] as HTMLElement).click();
                  return true;
                }
                // Try broader search
                const allInputs = document.querySelectorAll('input[type="file"]');
                for (const input of allInputs) {
                  const parent = input.closest('[class*="cover"], [class*="Cover"], [class*="title-image"], [class*="TitleImage"]');
                  if (parent) {
                    (input as HTMLElement).click();
                    return true;
                  }
                }
                if (allInputs.length > 0) {
                  (allInputs[0] as HTMLElement).click();
                  return true;
                }
                return false;
              });

              if (hasFileInput) {
                const fileChooser = await page.waitForEvent('filechooser', { timeout: 10000 });
                await fileChooser.setFiles(absImagePath);
                uploaded = true;
                console.log('[zhihu] Cover image uploaded via JS click!');
                await page.waitForTimeout(8000);

                const confirmPath = path.join(process.cwd(), 'groups', 'main', 'logs', 'zhihu-cover-done.png');
                await page.screenshot({ path: confirmPath, fullPage: false });
                console.log(`[zhihu] Confirm screenshot: ${confirmPath}`);
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.log(`[zhihu] JS click approach failed: ${msg}`);
            }
          }
        }

        if (!uploaded) {
          console.log('[zhihu] Warning: Could not upload cover image.');
          const afterPath = path.join(process.cwd(), 'groups', 'main', 'logs', 'zhihu-no-cover.png');
          await page.screenshot({ path: afterPath, fullPage: false });
          console.log(`[zhihu] Debug screenshot: ${afterPath}`);
        }
      } catch (err) {
        const imgErr = err instanceof Error ? err.message : String(err);
        console.log(`[zhihu] Warning: Cover image upload failed: ${imgErr}`);
      }
    }

    console.log('[zhihu] Waiting for auto-save...');
    await page.waitForTimeout(3000);

    // Try to get the draft URL from the page
    const draftUrl = page.url();

    console.log(`[zhihu] Draft URL: ${draftUrl}`);
    console.log('[zhihu] Done!');

    await browser.close();

    return {
      success: true,
      draftUrl,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[zhihu] Error: ${error}`);
    await browser.close();
    return { success: false, error };
  }
}

async function loginOnly(): Promise<void> {
  fs.mkdirSync(BROWSER_STATE_DIR, { recursive: true });

  console.log('[zhihu] Opening browser for manual login...');
  console.log('[zhihu] Please log in to Zhihu. The session will be saved.');

  const browser = await chromium.launchPersistentContext(BROWSER_STATE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = browser.pages()[0] || (await browser.newPage());
  await page.goto('https://www.zhihu.com/signin', {
    waitUntil: 'domcontentloaded',
  });

  console.log('[zhihu] Waiting for login (up to 5 minutes)...');
  try {
    await page.waitForURL('https://www.zhihu.com/', { timeout: 300000 });
    console.log('[zhihu] Login successful! Session saved.');
  } catch {
    console.log('[zhihu] Timeout waiting for login.');
  }

  await browser.close();
}

// CLI entry point
const args = process.argv.slice(2);

if (args.includes('--login')) {
  loginOnly().catch(console.error);
} else {
  const titleIdx = args.indexOf('--title');
  const contentIdx = args.indexOf('--content');
  const coverIdx = args.indexOf('--cover');

  if (titleIdx === -1 || contentIdx === -1) {
    console.log(
      'Usage: npx tsx scripts/zhihu-publisher.ts --title "标题" --content path/to/file.html [--cover path/to/cover.jpg]',
    );
    console.log(
      '       npx tsx scripts/zhihu-publisher.ts --login   (first-time login)',
    );
    process.exit(1);
  }

  const title = args[titleIdx + 1];
  const contentFile = args[contentIdx + 1];
  const coverImage = coverIdx !== -1 ? args[coverIdx + 1] : undefined;

  publishToZhihu(title, contentFile, coverImage).then((result) => {
    console.log(JSON.stringify(result));
    process.exit(result.success ? 0 : 1);
  });
}
