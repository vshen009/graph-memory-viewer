from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1400, "height": 900})

    errors = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda err: errors.append(str(err)))

    page.goto("http://127.0.0.1:7823/viewer/", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(5000)  # 等物理引擎稳定

    # 截图
    page.screenshot(path="/home/trinity/.openclaw/workspace/projects/graph-memory-viewer/screenshot-community.png", full_page=False)
    print("Screenshot saved")

    if errors:
        print("Errors:", errors)
    else:
        print("No errors")

    browser.close()
