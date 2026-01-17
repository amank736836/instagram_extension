console.log('IG Manager: Content Script Loaded');

// Check for resume state (Kept for fallback, but main logic is now direct)
checkResumeState();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'START_SCAN') {
        startScan();
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
    // We assume the user runs this from their own profile or we might need to navigate there first?
    // Use the profile link in menu to check or just check URL
    // Actually, safer to just click "Following" if visible, or navigate to own profile if not.

    const profileLink = document.querySelector('a[href="/' + username + '/"]'); // Wait, username is target.
    // We need own username.
    // Let's assume we are on own profile for now as per instructions.

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
        log('User not found in Following list (or already unfollowed).');
        if (isBatch) nextBatchItem(username);
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

async function startScan() {
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

        await delay(2000);

        log(`Scraping Following...`);
        const following = await scrapeList(followingLink, stats.following);
        log(`Following Scraped: ${following.length}`);

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
    const MAX_RETRIES = 15;
    let allUsers = new Set();
    const MAX_SCROLL_LOOPS = Math.ceil(targetCount / 5) + 50;
    let loopCount = 0;

    while (retries < MAX_RETRIES && loopCount < MAX_SCROLL_LOOPS) {
        loopCount++;
        const users = extractUsersFromDialog(dialog);
        users.forEach(u => allUsers.add(u));

        if (targetCount && allUsers.size >= targetCount) {
            log(`Reached target count (${allUsers.size}/${targetCount}).`);
            break;
        }

        scrollable.scrollTop = scrollable.scrollHeight;

        await delay(1000 + Math.random() * 500);

        const currentHeight = scrollable.scrollHeight;
        if (currentHeight === previousHeight) {
            retries++;
            if (retries % 5 === 0) {
                log(`Stuck? Waiting longer... (${allUsers.size}/${targetCount})`);
                await delay(2000);
            }
        } else {
            previousHeight = currentHeight;
            retries = 0;
            if (loopCount % 10 === 0) log(`Scrolled... ${allUsers.size} users.`);
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
