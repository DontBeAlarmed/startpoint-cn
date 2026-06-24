async function editField(field, value) {
    const r = await fetch('/api/player/' + PID + '/field', {
        method: 'PATCH',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'field=' + encodeURIComponent(field) + '&value=' + encodeURIComponent(value)
    });
    const d = await r.json();
    if (!r.ok) alert(d.error);
}

async function addChar() {
    const code = document.getElementById('charCode').value;
    const r = await fetch('/api/player/' + PID + '/character', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'code=' + encodeURIComponent(code)
    });
    if (r.ok) location.reload();
    else { const d = await r.json(); document.getElementById('charMsg').textContent = d.error; }
}

async function delChar(code) {
    if (!confirm('删除角色 ' + code + '?')) return;
    const r = await fetch('/api/player/' + PID + '/character/' + code, { method: 'DELETE' });
    if (r.ok) location.reload();
}

async function addItem() {
    const id = document.getElementById('itemId').value;
    const count = document.getElementById('itemCount').value;
    const r = await fetch('/api/player/' + PID + '/item', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'id=' + encodeURIComponent(id) + '&count=' + encodeURIComponent(count)
    });
    if (r.ok) location.reload();
    else { const d = await r.json(); document.getElementById('itemMsg').textContent = d.error; }
}

async function delItem(itemId) {
    if (!confirm('删除道具 ' + itemId + '?')) return;
    const r = await fetch('/api/player/' + PID + '/item/' + itemId, { method: 'DELETE' });
    if (r.ok) location.reload();
}

async function delQuestProgress(section, questId) {
    if (!confirm('删除关卡 section=' + section + ' quest=' + questId + '?')) return;
    const r = await fetch('/api/player/' + PID + '/quest_progress/' + section + '/' + questId, { method: 'DELETE' });
    if (r.ok) location.reload();
}

async function delAllQuestProgress() {
    if (!confirm('删除全部关卡进度?')) return;
    const r = await fetch('/api/player/' + PID + '/quest_progress', { method: 'DELETE' });
    if (r.ok) location.reload();
}

async function delDrawnQuest(catId, questId) {
    if (!confirm('删除抽选关卡 category=' + catId + ' quest=' + questId + '?')) return;
    const r = await fetch('/api/player/' + PID + '/drawn_quest/' + catId + '/' + questId, { method: 'DELETE' });
    if (r.ok) location.reload();
}

async function delAllDrawnQuests() {
    if (!confirm('删除全部抽选关卡?')) return;
    const r = await fetch('/api/player/' + PID + '/drawn_quest', { method: 'DELETE' });
    if (r.ok) location.reload();
}

async function resetChallenge() {
    if (!confirm('将所有每日挑战次数恢复至 CDN 默认值？')) return;
    const r = await fetch('/api/player/' + PID + '/reset_challenge', { method: 'POST' });
    if (r.ok) { alert('已恢复'); location.reload(); }
    else { const d = await r.json().catch(() => ({})); alert('恢复失败：' + (d.error || r.status)); }
}

async function clearMailbox() {
    if (!confirm('清空该存档的全部邮件？此操作不可撤销（用于误发非法邮件导致游戏崩溃时恢复）。')) return;
    const r = await fetch('/api/player/' + PID + '/mail', { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { alert('已清空 ' + (d.deleted ?? 0) + ' 封邮件'); location.reload(); }
    else { alert('清空失败：' + (d.error || r.status)); }
}
