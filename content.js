// Helper functions
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
    console.log(`[IG Manager] ${msg}`);
    chrome.runtime.sendMessage({ action: 'LOG', message: msg }).catch(() => { });
}

console.log('IG Manager: Content Script Loaded');

// Check for resume state (Kept for fallback, but main logic is now direct)
checkResumeState();

let isScanning = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'START_SCAN') {
        isScanning = true;
        startScan();
    } else if (request.action === 'STOP_SCAN') {
        isScanning = false;
        log('Stopping scan...');
    } else if (request.action === 'START_UNFOLLOW') {
        startBatchUnfollow();
    } else if (request.action === 'UNFOLLOW_USER') {
        // Use the new Search strategy
        unfollowViaFollowingList(request.username);
    }
    return true; // Keep channel open
});

function log(msg) {
    console.log(`[IG Manager] ${msg}`);
    chrome.runtime.sendMessage({ action: 'LOG', message: msg }).catch(() => { });
}

async function checkResumeState() {
    chrome.storage.local.get(['actionState'], (result) => {
        const state = result.actionState;
        if (!state) return;

        if (state.type === 'UNFOLLOW_SINGLE' && state.step === 'NAVIGATED') {
            log(`Resuming unfollow for ${state.user}...`);
            resumeUnfollow(state.user);
        } else if (state.type === 'BATCH_UNFOLLOW' && state.step === 'NAVIGATED') {
            log(`Resuming batch unfollow for ${state.user}...`);
            resumeUnfollow(state.user, true); // true = isBatch
        } else if (state.type === 'BATCH_UNFOLLOW' && state.step === 'SEARCHING') {
            log(`Resuming batch unfollow for ${state.user}...`);
            unfollowViaFollowingList(state.user, true);
        } else if (state.type === 'SCAN_INIT') {
            handleScanInit();
        } else if (state.type === 'STORY_INIT') {
            log('Initializing Story Viewer...');
            chrome.storage.local.remove(['actionState']);
            startStoryViewer();
        }
    });
}

async function handleScanInit() {
    log('Scan Initialization detected. Checking for profile...');

    // Retry loop to wait for PROFILE STATS
    let stats = { followers: 0, following: 0 };
    let statsAttempts = 0;

    while ((stats.followers === 0 && stats.following === 0) && statsAttempts < 10) {
        statsAttempts++;
        stats = getProfileStats();
        if (stats.followers > 0 || stats.following > 0) break;

        log(`Waiting for profile data... (${statsAttempts}/10)`);
        await delay(1000);
    }

    if (stats.followers > 0 || stats.following > 0) {
        log('On Profile Page. Starting Scan...');
        // Clear init state
        await chrome.storage.local.remove(['actionState']);
        startScan();
        return;
    }

    log('Not on profile (or stats failed to load). Navigating...');

    // Retry loop to wait for page load (Sidebar might take a few seconds)
    let profileLink = null;
    let attempts = 0;

    while (!profileLink && attempts < 10) {
        attempts++;
        const links = Array.from(document.querySelectorAll('a'));

        profileLink = links.find(a => {
            // Check 1: Exact text match (Sidebar usually has "Profile" hidden or visible)
            if (a.innerText.includes('Profile')) return true;

            // Check 2: Image alt text
            const img = a.querySelector('img');
            if (img && img.alt && img.alt.includes('profile picture')) return true;

            return false;
        });

        if (!profileLink) {
            log(`Waiting for navigation sidebar... (${attempts}/10)`);
            await delay(1000);
        }
    }

    if (profileLink) {
        log('Found Profile link. Clicking...');
        profileLink.click();

        // SPA Handling: Wait for navigation and verify stats again
        log('Waiting for profile to load...');
        await delay(3000);

        let retry = 0;
        while (retry < 15) {
            retry++;
            const s = getProfileStats();
            if (s.followers > 0 || s.following > 0) {
                log('Profile loaded. Starting Scan...');
                await chrome.storage.local.remove(['actionState']);
                startScan();
                return;
            }
            log(`Waiting for stats... (${retry}/15)`);
            await delay(1000);
        }
        log('Timed out waiting for profile stats.');

    } else {
        log('Could not find Profile link after waiting. Please navigate manually.');
    }
}

async function unfollowViaFollowingList(username, isBatch = false) {
    log(`Unfollowing ${username} via Following list...`);

    // 1. Ensure we are on own profile
    const editProfileBtn = document.querySelector('a[href="/accounts/edit/"]');
    if (!editProfileBtn) {
        log('Not on own profile. Navigating...');
        const success = await navigateToProfile();
        if (!success) {
            log('Error: Could not navigate to profile. Aborting...');
            return;
        }
    }

    // 2. Open Following Modal
    const links = Array.from(document.querySelectorAll('a'));
    const followingLink = links.find(el => el.innerText.includes('following') || el.href.includes('following'));

    if (!followingLink) {
        log('Error: Could not find "Following" link. Go to your profile.');
        return;
    }

    followingLink.click();
    await delay(3000);

    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) {
        log('Error: Following modal did not open.');
        return;
    }

    // 3. Find Search Input
    const inputs = Array.from(dialog.querySelectorAll('input'));
    const searchInput = inputs.find(i => i.placeholder.toLowerCase().includes('search') || i.getAttribute('aria-label') === 'Search input');

    if (!searchInput) {
        log('Warning: Search input not found. Skipping user...');
        closeDialog(dialog);

        // Remove from list to avoid infinite loop
        chrome.storage.local.get(['nonFollowers'], (result) => {
            if (result.nonFollowers) {
                const newList = result.nonFollowers.filter(u => u !== username);
                chrome.storage.local.set({ nonFollowers: newList });
                // Update UI stats if needed, or just proceed
            }

            if (isBatch) {
                log(`Skipped ${username}. Moving to next in 3s...`);
                setTimeout(() => nextBatchItem(username), 3000);
            }
        });
        return;
    }

    // 4. Type Username
    log(`Searching for ${username}...`);
    // React input typing usually requires setting value and firing event
    setReactInputValue(searchInput, username);

    await delay(3000); // Wait for search results

    // 5. Find Target User Row
    // The search result should show the user. We look for a row containing the username AND a "Following" button.
    // We need to be careful not to click "Follow" (blue) but "Following" (grey/secondary).

    // Strategy: Find all buttons in the dialog. 
    // Filter for buttons that say "Following".
    // Check if that button is close to the username text.

    const buttons = Array.from(dialog.querySelectorAll('button'));
    const followingBtns = buttons.filter(b => b.innerText === 'Following');

    if (followingBtns.length === 0) {
        log(`User ${username} not found in Following list (or already unfollowed). Skipping...`);

        // REMOVE FROM LIST TO PREVENT INFINITE LOOP
        chrome.storage.local.get(['nonFollowers'], (result) => {
            if (result.nonFollowers) {
                const newList = result.nonFollowers.filter(u => u !== username);
                chrome.storage.local.set({ nonFollowers: newList });

                // Update Badge/Stats
                chrome.runtime.sendMessage({
                    action: 'STATS_UPDATE',
                    followers: 0, // We don't know the new count, but we can pass current or 0 to ignore
                    following: 0,
                    nonFollowers: newList.length
                });
            }

            // Close dialog to reset state for next search
            closeDialog(dialog);

            if (isBatch) {
                setTimeout(() => nextBatchItem(username), 2000);
            }
        });
        return;
    }

    // If multiple results (rare for exact username search), pick first one ensuring it matches username
    // Ideally we check semantic structure but picking first "Following" button in search result is usually correct for exact match
    const targetBtn = followingBtns[0];

    log('Found user. Clicking Following...');
    targetBtn.click();

    await delay(2000);

    // 6. Confirm Unfollow
    // A new modal (or overlay) appears
    // We look for button "Unfollow"
    // Since we are inside a dialog, and the confirm is likely a nested dialog or top-layer div
    // We scan document for "Unfollow" button
    const allButtons = Array.from(document.querySelectorAll('button'));
    const confirmBtn = allButtons.find(b => b.innerText === 'Unfollow');

    if (confirmBtn) {
        confirmBtn.click();
        log(`Unfollowed ${username} successfully.`);

        // Remove from list
        chrome.storage.local.get(['nonFollowers'], (result) => {
            if (result.nonFollowers) {
                const newList = result.nonFollowers.filter(u => u !== username);
                chrome.storage.local.set({ nonFollowers: newList });
                chrome.runtime.sendMessage({
                    action: 'STATS_UPDATE',
                    followers: 0,
                    following: 0,
                    nonFollowers: newList.length
                });
            }
        });

        // Close modal (Search modal) - Optional, prevents clutter
        // closeDialog(dialog); 
        // Actually, for batch, we might want to keep it open? 
        // But refreshing the search is easier if we close and reopen or just clear input.
        // Let's close it to be clean.
        closeDialog(dialog);

        if (isBatch) {
            await delay(5000 + Math.random() * 3000);
            nextBatchItem(username);
        }

    } else {
        log('Error: specific Unfollow confirmation button not found.');
    }
}

// React input helper
function setReactInputValue(input, value) {
    const lastValue = input.value;
    input.value = value;
    const event = new Event('input', { bubbles: true });
    // React 15/16 hack
    const tracker = input._valueTracker;
    if (tracker) {
        tracker.setValue(lastValue);
    }
    input.dispatchEvent(event);
}

function nextBatchItem(finishedUser) {
    chrome.storage.local.get(['nonFollowers'], (result) => {
        const list = result.nonFollowers;
        if (list && list.length > 0) {
            unfollowViaFollowingList(list[0], true);
        } else {
            log('Batch complete.');
        }
    });
}

// ... Keep existing startScan, getProfileStats, scrapeList logic ...
// (Omitting repetition for brevity in artifact update, but full file will be marked overwrite)
// I will include the existing functions below to ensure full file validity

// ... Copied existing functions ...

function getProfileStats() {
    const getCount = (href) => {
        const link = document.querySelector(`a[href$="${href}"]`);
        if (!link) return 0;
        const titleSpan = link.querySelector('span[title]');
        if (titleSpan) {
            const raw = titleSpan.getAttribute('title').replace(/,/g, '');
            if (!isNaN(parseInt(raw))) return parseInt(raw);
        }
        const text = link.innerText.replace(/[^0-9KM.,]/g, '').trim();
        if (!text) return 0;
        if (text.includes('K')) return parseFloat(text) * 1000;
        if (text.includes('M')) return parseFloat(text) * 1000000;
        return parseInt(text.replace(/,/g, ''));
    };
    return { followers: getCount('/followers/'), following: getCount('/following/') };
}

async function startScan(retryCount = 0) {
    isScanning = true; // Force True explicitly at start
    log('Analyzing profile...');
    const stats = getProfileStats();
    if (stats.followers === 0 && stats.following === 0) {
        log('Error: Could not read profile stats. Are you on your profile page?');
        return;
    }
    log(`Profile Stats: ${stats.followers} / ${stats.following}`);

    const links = Array.from(document.querySelectorAll('a'));
    const followersLink = links.find(el => el.innerText.includes('followers') || el.href.includes('followers'));
    const followingLink = links.find(el => el.innerText.includes('following') || el.href.includes('following'));

    if (!followersLink || !followingLink) {
        log('Error: Could not find Followers/Following links.');
        return;
    }

    try {
        log(`Scraping Followers...`);
        const followers = await scrapeList(followersLink, stats.followers);
        log(`Followers Scraped: ${followers.length}`);

        // Auto-Retry Logic (Accuracy Check)
        if (followers.length === 0 && stats.followers > 0 && isScanning) {
            if (retryCount < 2) {
                log(`Warning: Zero followers scraped. Retrying... (${retryCount + 1}/2)`);
                await delay(2000);
                startScan(retryCount + 1);
                return;
            } else {
                log('Error: Failed to scrape followers after retries.');
            }
        }

        await delay(2000);

        if (!isScanning) return; // Check stop before next step

        log(`Scraping Following...`);
        const following = await scrapeList(followingLink, stats.following);
        log(`Following Scraped: ${following.length}`);

        // Auto-Retry Logic for Following
        if (following.length === 0 && stats.following > 0 && isScanning) {
            if (retryCount < 2) {
                log(`Warning: Zero following scraped. Retrying... (${retryCount + 1}/2)`);
                await delay(2000);
                startScan(retryCount + 1);
                return;
            }
        }

        log('Analyzing...');
        const followersSet = new Set(followers);
        const nonFollowers = following.filter(user => !followersSet.has(user));

        log(`Found ${nonFollowers.length} users not following back.`);

        chrome.storage.local.set({
            followers: followers,
            following: following,
            nonFollowers: nonFollowers
        });

        chrome.runtime.sendMessage({
            action: 'STATS_UPDATE',
            followers: followers.length,
            following: following.length,
            nonFollowers: nonFollowers.length
        });

        log('Scan Complete!');

    } catch (e) {
        log(`Error during scan: ${e.message}`);
    }
}

async function scrapeList(clickTarget, targetCount) {
    clickTarget.click();
    await delay(3000);

    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) throw new Error('Modal did not open');

    const scrollable = findScrollableChild(dialog);
    if (!scrollable) {
        closeDialog(dialog);
        throw new Error('Could not find list container');
    }

    log('List opened. Starting scroll...');

    let previousHeight = 0;
    let retries = 0;
    const MAX_RETRIES = 20; // Increased retries since we are just waiting
    let allUsers = new Set();
    const MAX_SCROLL_LOOPS = Math.ceil(targetCount / 5) + 50;
    let loopCount = 0;

    while (retries < MAX_RETRIES && loopCount < MAX_SCROLL_LOOPS) {
        // Safety Check: Is modal still open?
        if (!document.body.contains(dialog)) {
            log('Error: Modal closed unexpectedly. (Manual close?)');
            break;
        }

        loopCount++;
        const users = extractUsersFromDialog(dialog);
        users.forEach(u => allUsers.add(u));

        if (targetCount && allUsers.size >= targetCount) {
            log(`Reached target count (${allUsers.size}/${targetCount}).`);
            break;
        }

        // Simple Scroll Logic (Reverted as per user request)
        scrollable.scrollTop = scrollable.scrollHeight;

        await delay(1200 + Math.random() * 500); // Slightly longer base delay

        const currentHeight = scrollable.scrollHeight;
        if (currentHeight === previousHeight) {
            retries++;
            if (retries % 5 === 0) {
                log(`Waiting for items to load... (${allUsers.size}/${targetCount})`);
                await delay(2000); // Extra wait

                // Very gentle nudge only if really stuck
                scrollable.scrollTop = scrollable.scrollHeight - 50;
                await delay(200);
                scrollable.scrollTop = scrollable.scrollHeight;
            }
        } else {
            previousHeight = currentHeight;
            retries = 0;
            if (loopCount % 5 === 0) log(`Scrolled... ${allUsers.size} users found.`);
        }
    }

    closeDialog(dialog);
    await delay(1000);
    return Array.from(allUsers);
}

function closeDialog(dialog) {
    if (!dialog) return;
    const closeSVG = dialog.querySelector('svg[aria-label="Close"]');
    if (closeSVG && closeSVG.closest('button')) {
        closeSVG.closest('button').click();
    } else {
        if (dialog.parentElement) dialog.parentElement.click();
    }
}

function findScrollableChild(parent) {
    if (!parent) return null;
    const divs = Array.from(parent.querySelectorAll('div'));
    let existing = divs.find(el => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    });
    if (existing) return existing;
    existing = divs.find(el => {
        const style = window.getComputedStyle(el);
        return style.overflowY === 'auto' || style.overflowY === 'scroll';
    });
    if (existing) return existing;
    return parent.querySelector('._aano');
}

function extractUsersFromDialog(dialog) {
    const potentialLinks = Array.from(dialog.querySelectorAll('a'));
    const usernames = [];
    potentialLinks.forEach(a => {
        const href = a.getAttribute('href');
        if (href && href.startsWith('/') && href.split('/').length === 3) {
            const text = a.innerText;
            if (text && text.length > 0 && text !== 'Follow' && text !== 'Remove' && text !== 'Message') {
                const username = href.replace(/\//g, '');
                usernames.push(username);
            }
        }
    });
    return usernames;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function startBatchUnfollow() {
    chrome.storage.local.get(['nonFollowers'], async (result) => {
        const list = result.nonFollowers;
        if (list && list.length > 0) {
            unfollowViaFollowingList(list[0], true);
        } else {
            log('No users to unfollow.');
        }
    });
}

// --- STORY VIEWER LOGIC ---

async function startStoryViewer() {
    log('Starting Auto Story Viewer...');

    // 1. Ensure on Home Feed
    if (window.location.pathname !== '/') {
        log('Navigating to Home Feed...');
        const homeBtn = document.querySelector('a[href="/"] svg[aria-label="Home"]');
        if (homeBtn) {
            homeBtn.closest('a').click();
        } else {
            window.location.href = 'https://www.instagram.com/';
        }
        await delay(5000);
    }

    // 2. Find Story Tray
    log('Looking for stories...');
    // Home feed story tray is usually a 'ul' or 'div' with roll="menu" or similar presentation
    // We look for the first canvas elements which are the story rings
    await delay(2000);

    // Select all canvases that are likely story rings (size check ~66px or ~87px)
    // On home feed, they are in a horizontal row at the top
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const storyCanvases = canvases.filter(c => {
        const rect = c.getBoundingClientRect();
        return rect.height > 55 && rect.top < 250;
    });

    if (storyCanvases.length === 0) {
        log('Error: No stories found in tray.');
        return;
    }

    // Filter for unread? 
    // Usually unread have a gradient ring. Read have a grey ring.
    // We can't easily check color via JS without complex canvas analysis.
    // BUT, usually the first one in the list IS unread if it's there.

    // We explicitly click the *first* available story canvas to start the chain.
    const firstStory = storyCanvases[0];

    if (firstStory) {
        log('Opening first story...');
        firstStory.click();

        await delay(3000);
        await watchStoryLoop();
        log('Story Viewer session ended.');
    }
}

async function watchStoryLoop() {
    let active = true;
    let storiesWatched = 0;
    const MAX_STORIES = 300;

    log('Entering Watch Loop...');

    while (active && storiesWatched < MAX_STORIES) {
        // 1. Check if we are still in Story Mode
        if (!window.location.pathname.startsWith('/stories/')) {
            log('Exited story mode (URL change). Stopping.');
            active = false;
            break;
        }

        storiesWatched++;
        const viewTime = 2000 + Math.random() * 3000; // 2-5 seconds

        // --- LIKE LOGIC ---
        await delay(1000 + Math.random() * 1000); // Wait 1-2s before liking

        // Find Like Button
        const likeSvg = document.querySelector('svg[aria-label="Like"]');
        if (likeSvg) {
            const likeBtn = likeSvg.closest('[role="button"]') || likeSvg.parentElement;
            if (likeBtn) {
                log('Liking story... ❤️');
                likeBtn.click();
                await delay(500);
            }
        }

        // Wait remaining time
        const remainingTime = Math.max(500, viewTime - 2000);
        await delay(remainingTime);

        // --- NEXT LOGIC ---
        const nextSvg = document.querySelector('svg[aria-label="Next"]');
        if (nextSvg) {
            const nextBtn = nextSvg.closest('[role="button"]') || nextSvg.parentElement;
            if (nextBtn) {
                // log('Next story...');
                nextBtn.click();
            } else {
                log('Next button found but not clickable. Using ArrowRight.');
                simulateRightKey();
            }
        } else {
            // Fallback: Click right side of screen
            log('Next button hidden. Clicking screen right side...');
            simulateClickAtScreen('right');

            await delay(2000);
            if (!document.querySelector('svg[aria-label="Next"]') && !window.location.pathname.startsWith('/stories/')) {
                log('Story chain ended.');
                active = false;
            }
        }

        await delay(500); // Small pause between stories
    }
}

function simulateRightKey() {
    const event = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        code: 'ArrowRight',
        bubbles: true
    });
    document.dispatchEvent(event);
}

function simulateClickAtScreen(side) {
    const x = side === 'right' ? window.innerWidth * 0.9 : window.innerWidth * 0.1;
    const y = window.innerHeight / 2;
    const el = document.elementFromPoint(x, y);
    if (el) el.click();
}

// Update Message Listener to handle STORY_INIT
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // ... existing handlers ...
    if (request.action === 'START_SCAN') {
        isScanning = true;
        startScan();
    } else if (request.action === 'STOP_SCAN') {
        isScanning = false;
        log('Stopping scan...');
    } else if (request.action === 'START_UNFOLLOW') {
        startBatchUnfollow();
    } else if (request.action === 'UNFOLLOW_USER') {
        unfollowViaFollowingList(request.username);
    }
    // NEW: Story Handler is triggered via popup CheckResumeState usually, but can be direct
    else if (request.action === 'START_STORY_VIEWER') {
        startStoryViewer();
    }

    return true;
});

// Update checkResumeState for STORY_INIT
async function checkResumeState() {
    chrome.storage.local.get(['actionState'], (result) => {
        const state = result.actionState;
        if (!state) return;

        if (state.type === 'UNFOLLOW_SINGLE' && state.step === 'NAVIGATED') {
            // ...
            resumeUnfollow(state.user);
        } else if (state.type === 'BATCH_UNFOLLOW' && state.step === 'NAVIGATED') {
            // ...
            resumeUnfollow(state.user, true);
        } else if (state.type === 'BATCH_UNFOLLOW' && state.step === 'SEARCHING') {
            // ...
            unfollowViaFollowingList(state.user, true);
        } else if (state.type === 'SCAN_INIT') {
            handleScanInit();
        } else if (state.type === 'STORY_INIT') {
            // Clear state and start
            chrome.storage.local.remove(['actionState']);
            startStoryViewer();
        }
    });
}
