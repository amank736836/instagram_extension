document.addEventListener('DOMContentLoaded', () => {
    const btnScan = document.getElementById('btnScan');
    const btnWatchStories = document.getElementById('btnWatchStories');
    const btnUnfollow = document.getElementById('btnUnfollow');
    const logsDiv = document.getElementById('logs');
    const userListDiv = document.getElementById('userList');

    // UI State Helpers
    function log(msg) {
        const div = document.createElement('div');
        div.className = 'log-item';
        div.textContent = `> ${msg}`;
        logsDiv.prepend(div);
    }

    function updateStats(followers, following, nonFollowers) {
        document.getElementById('followersCount').textContent = followers || '-';
        document.getElementById('followingCount').textContent = following || '-';
        document.getElementById('nonFollowersCount').textContent = nonFollowers || '-';
    }

    function renderUserList(users) {
        userListDiv.innerHTML = '';
        if (users.length === 0) {
            userListDiv.innerHTML = '<div class="user-item">No users found</div>';
            return;
        }
        users.forEach(u => {
            const div = document.createElement('div');
            div.className = 'user-item';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = u;
            nameSpan.style.flex = '1';

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'item-actions';

            const visitBtn = document.createElement('button');
            visitBtn.textContent = 'Visit';
            visitBtn.className = 'small-btn';
            visitBtn.onclick = () => window.open(`https://www.instagram.com/${u}/`, '_blank');

            const unfollowBtn = document.createElement('button');
            unfollowBtn.textContent = 'Unfollow';
            unfollowBtn.className = 'small-btn danger-btn';
            unfollowBtn.onclick = async () => {
                unfollowBtn.textContent = '...';
                unfollowBtn.disabled = true;

                // Robust Tab Discovery: Find ANY Instagram tab, not just the active one in the current window
                // This fixes issues when using Detached Mode or if the user clicked away.
                const tabs = await chrome.tabs.query({ url: "*://www.instagram.com/*" });

                if (tabs && tabs.length > 0) {
                    // Pick the active one if possible, otherwise the first one
                    const targetTab = tabs.find(t => t.active) || tabs[0];

                    log(`Sending Unfollow command for ${u} to tab ${targetTab.id}...`);
                    chrome.tabs.sendMessage(targetTab.id, { action: 'UNFOLLOW_USER', username: u });
                } else {
                    log('Error: No Instagram tab found. Please open Instagram.');
                    unfollowBtn.textContent = 'Unfollow';
                    unfollowBtn.disabled = false;
                }
            };

            actionsDiv.appendChild(visitBtn);
            actionsDiv.appendChild(unfollowBtn);

            div.appendChild(nameSpan);
            div.appendChild(actionsDiv);
            userListDiv.appendChild(div);
        });
    }

    // Load saved state
    chrome.storage.local.get(['followers', 'following', 'nonFollowers'], (result) => {
        const f = result.followers ? result.followers.length : 0;
        const fg = result.following ? result.following.length : 0;
        const nf = result.nonFollowers ? result.nonFollowers.length : 0;
        updateStats(f, fg, nf);

        if (result.nonFollowers && result.nonFollowers.length > 0) {
            btnUnfollow.disabled = false;
            renderUserList(result.nonFollowers);
        }
    });

    // Old List Button listeners removed because we use Tabs now.

    // Auto-switch to List tab on click of "Don't Follow Back" card
    document.getElementById('nonFollowersCard').addEventListener('click', () => {
        const listTabBtn = document.getElementById('btn-tab-list');
        if (listTabBtn) listTabBtn.click();
    });

    const btnDetach = document.getElementById('btn-detach');

    // Detach Handler
    if (btnDetach) {
        btnDetach.addEventListener('click', () => {
            chrome.windows.create({
                url: chrome.runtime.getURL("popup.html"),
                type: "popup",
                width: 400,
                height: 600
            });
            window.close(); // Close current popup
        });
    }

    // Event Listeners
    btnScan.addEventListener('click', async () => {
        log('Initializing Scan...');

        // Set state to pending
        chrome.storage.local.set({
            actionState: { type: 'SCAN_INIT' }
        }, () => {
            log('Opening Instagram...');
            chrome.tabs.create({ url: 'https://www.instagram.com/' });
            // Window will close here usually
        });
    });

    btnWatchStories.addEventListener('click', async () => {
        log('Initializing Story Viewer...');
        chrome.storage.local.set({
            actionState: { type: 'STORY_INIT' }
        }, () => {
            log('Opening Instagram Home...');
            chrome.tabs.create({ url: 'https://www.instagram.com/' });
        });
    });

    btnUnfollow.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        log('Starting Unfollow sequence...');
        chrome.tabs.sendMessage(tab.id, { action: 'START_UNFOLLOW' });
    });

    // Tab Logic
    const tabs = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const badge = document.getElementById('nf-badge');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Deactivate all
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            // Activate current
            tab.classList.add('active');
            const targetId = tab.getAttribute('data-tab');
            document.getElementById(targetId).classList.add('active');
        });
    });

    // Update stats and Badge
    function updateStats(followers, following, nonFollowers) {
        document.getElementById('followersCount').textContent = followers || '-';
        document.getElementById('followingCount').textContent = following || '-';
        document.getElementById('nonFollowersCount').textContent = nonFollowers || '-';

        if (nonFollowers > 0) {
            badge.textContent = nonFollowers;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    // ... (Keep renderUserList logic) ...

    // Listen for messages from content script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'LOG') {
            log(request.message);
        } else if (request.action === 'STATS_UPDATE') {
            updateStats(request.followers, request.following, request.nonFollowers);

            if (request.nonFollowers > 0) {
                btnUnfollow.disabled = false;
                badge.textContent = request.nonFollowers;
                badge.classList.remove('hidden');
            }

            // Re-fetch list to render
            chrome.storage.local.get(['nonFollowers'], (res) => {
                if (res.nonFollowers) renderUserList(res.nonFollowers);
            });
        }
    });
});
