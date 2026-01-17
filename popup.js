document.addEventListener('DOMContentLoaded', () => {
    const btnScan = document.getElementById('btnScan');
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
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.url.includes('instagram.com')) {
                    chrome.tabs.sendMessage(tab.id, { action: 'UNFOLLOW_USER', username: u });
                } else {
                    log('Error: Instagram tab not active');
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

    // Toggle List
    document.getElementById('nonFollowersCard').addEventListener('click', () => {
        userListDiv.classList.toggle('hidden');
    });

    // Event Listeners
    btnScan.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab.url.includes('instagram.com')) {
            log('Error: Please open Instagram first.');
            return;
        }

        log('Starting Scan...');
        chrome.tabs.sendMessage(tab.id, { action: 'START_SCAN' }, (response) => {
            if (chrome.runtime.lastError) {
                log('Error: Refresh page and try again.');
            } else {
                log('Scan command sent.');
            }
        });
    });

    btnUnfollow.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        log('Starting Unfollow sequence...');
        chrome.tabs.sendMessage(tab.id, { action: 'START_UNFOLLOW' });
    });

    // Listen for messages from content script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'LOG') {
            log(request.message);
        } else if (request.action === 'STATS_UPDATE') {
            updateStats(request.followers, request.following, request.nonFollowers);
            if (request.nonFollowers > 0) btnUnfollow.disabled = false;

            // Re-fetch list to render
            chrome.storage.local.get(['nonFollowers'], (res) => {
                if (res.nonFollowers) renderUserList(res.nonFollowers);
            });
        }
    });
});
