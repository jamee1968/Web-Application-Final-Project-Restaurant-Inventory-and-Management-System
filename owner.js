import { onAuthStateChanged, getAuth, signOut }
        from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
    import { collection, onSnapshot, doc, updateDoc, serverTimestamp }
        from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

    const OWNER_UID   = 'NvaISfjul6Y0mTNLBmSPZCGfHcB2';
    const MANAGER_UID = '1lucTi9XLecpPBZO8hXSvV3nRVM2';

    let db;
    try {
        ({ db } = await import('./firebase-config.js'));
    } catch (err) {
        console.error('Firebase failed to initialize:', err);
        alert('Could not connect to the database.');
    }

    const auth = getAuth();

    onAuthStateChanged(auth, (user) => {
        if (!user || user.uid !== OWNER_UID) {
            window.location.href = 'index.html';
            return;
        }
        listenDeliveries();
        listenSuppliersAndUsers();
    });

    window.handleOwnerLogout = async function () {
        await signOut(auth);
        window.location.href = 'index.html';
    };
    //---------------------------
    window.openInvoiceDetailsModal = function(orderId) {
    if (!orderId || orderId === 'undefined') {
        alert("Invalid Order ID selected.");
        return;
    }

    const grouped = window._ownerDeliveriesGrouped || {};
    let items = grouped[orderId] || [];

    // Fallback: If not found in grouped object, look in flat delivery cache
    if (items.length === 0 && window._aiDeliveriesCache) {
        items = window._aiDeliveriesCache.filter(d => (d.order_id || d.orderId || d.id) === orderId);
    }

    if (items.length === 0) {
        alert("Invoice details not found for Order ID: " + orderId);
        return;
    }

    let itemRows = items.map(item => `
        <tr style="border-bottom:1px solid #e2e8f0;">
            <td style="padding:10px 8px;"><strong>${item.ingredient_name || item.item_name || '—'}</strong></td>
            <td style="padding:10px 8px;">${item.quantity || 1} ${item.unit || ''}</td>
            <td style="padding:10px 8px;">৳${Number(item.unit_price || 0).toFixed(2)}</td>
            <td style="padding:10px 8px; text-align:right;"><strong style="color:#0f172a;">৳${Number(item.total_amount || 0).toFixed(2)}</strong></td>
        </tr>
    `).join('');

    const modal = document.getElementById('modalInvoiceDetails'); 
    const titleEl = document.getElementById('modalInvoiceTitle');
    const bodyEl = document.getElementById('modalInvoiceBody');

    if (!modal || !titleEl || !bodyEl) {
        alert("Modal elements not found on page.");
        return;
    }

    titleEl.innerHTML = `<i class="fas fa-file-invoice" style="margin-right:8px; color:#3b82f6;"></i> Invoice Breakdown: ${orderId}`;
    bodyEl.innerHTML = `
        <div style="max-height: 320px; overflow-y: auto;">
            <table style="width:100%; text-align:left; font-size:0.85rem; border-collapse:collapse;">
                <thead>
                    <tr style="border-bottom:2px solid #cbd5e1; background:#f8fafc; color:#0f172a;">
                        <th style="padding:8px;">Ingredient</th>
                        <th style="padding:8px;">Quantity</th>
                        <th style="padding:8px;">Unit Price</th>
                        <th style="padding:8px; text-align:right;">Total Amount</th>
                    </tr>
                </thead>
                <tbody>${itemRows}</tbody>
            </table>
        </div>
        <div style="margin-top:16px; padding-top:10px; border-top:1px solid #e2e8f0; font-size:0.75rem; color:#64748b; display:flex; justify-content:space-between; align-items:center;">
            <span>Supplier: <strong>${items[0]?.supplier_name || items[0]?.supplier_email || '—'}</strong></span>
            <span style="color:#ef4444; font-weight:600;"><i class="fas fa-lock"></i> Read-Only View (Manager Settlement Required)</span>
        </div>
    `;
    modal.style.display = 'flex';
};
    //-------------------------------------------download pdf of unpaid in AI-------------
    window.downloadPayableSchedulePDF = function() {
    const modalBody = document.getElementById('modalScheduleBody');

    if (!modalBody || modalBody.textContent.includes('No pending outlays')) {
        alert("No unpaid liabilities available to export.");
        return;
    }

    // 1. Create a styled container for clean PDF rendering
    const element = document.createElement('div');
    element.style.padding = '20px';
    element.style.fontFamily = 'Arial, sans-serif';
    element.style.color = '#0f172a';

    const currentDate = new Date().toLocaleDateString();

    // 2. Add header branding to the PDF document
    element.innerHTML = `
        <div style="margin-bottom: 20px; border-bottom: 2px solid #3b82f6; padding-bottom: 10px; display:flex; justify-content:space-between; align-items:center;">
            <div>
                <h2 style="margin:0; color:#1e293b; font-size:1.4rem;">Upcoming Payable Outlays Schedule</h2>
                <p style="margin:4px 0 0 0; color:#64748b; font-size:0.85rem;">Generated on: ${currentDate}</p>
            </div>
        </div>
        <div>
            ${modalBody.innerHTML}
        </div>
    `;

    // 3. PDF configuration options
    const opt = {
        margin:       [0.5, 0.5, 0.5, 0.5],
        filename:     `Payable_Outlays_${new Date().toISOString().slice(0, 10)}.pdf`,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2 },
        jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };

    // 4. Generate and download PDF directly
    html2pdf().set(opt).from(element).save();
};

    //------------------------------------------------------------------------------------
// --- AI STRATEGIC INSIGHTS LOGIC ENGINE ---
window._aiPriceHistoryData = {};
window._aiPriceHikesList = [];
window._aiDeliveriesCache = [];
window._suppliersCache = [];

function generateAiStrategicInsights(deliveries) {
    window._aiDeliveriesCache = deliveries;

    // -------------------------------------------------------------------
    // 1. PRICE SURGE ALERTS (MULTI-ITEM DETECTION LOGIC)
    // -------------------------------------------------------------------
    const itemHistory = {};
    deliveries.forEach(d => {
        if (d.ingredient_name && d.unit_price > 0) {
            const name = d.ingredient_name.trim();
            if (!itemHistory[name]) itemHistory[name] = [];
            itemHistory[name].push({
                price: Number(d.unit_price),
                supplier: d.supplier_name || d.supplier_email || 'Unknown Supplier',
                date: d.scheduled_date?.toDate?.() || new Date(0)
            });
        }
    });

    window._aiPriceHistoryData = itemHistory;
    const priceHikes = [];

    // Scan items for price increases
    for (const [itemName, records] of Object.entries(itemHistory)) {
        if (records.length >= 2) {
            records.sort((a, b) => a.date - b.date);
            const latest = records[records.length - 1];
            const previous = records[records.length - 2];

            if (latest.price > previous.price) {
                const diffPct = ((latest.price - previous.price) / previous.price) * 100;
                priceHikes.push({
                    name: itemName,
                    supplier: latest.supplier,
                    latestPrice: latest.price,
                    prevPrice: previous.price,
                    pct: diffPct,
                    pctFormatted: diffPct.toFixed(1)
                });
            }
        }
    }

    // Sort by largest percentage hike descending
    priceHikes.sort((a, b) => b.pct - a.pct);
    window._aiPriceHikesList = priceHikes;

    const priceContainer = document.getElementById('ai-insight-price');
    const actionContainer = document.getElementById('ai-price-action');

    if (priceHikes.length === 0) {
        priceContainer.innerHTML = `
            <div style="font-size:0.85rem; color:#10b981;">
                <i class="fas fa-circle-check"></i> Unit prices across all procurement items remain stable.
            </div>`;
        actionContainer.innerHTML = '';
    } else {
        // Render top 10 items dynamically (or fewer if DB has less)
        const displayItems = priceHikes.slice(0, 10);
        let htmlList = `<div style="display:flex; flex-direction:column; gap:8px;">`;
        
        displayItems.forEach((item, index) => {
            htmlList += `
                <div style="font-size: 0.9rem; color: var(--text-main); border-bottom: 1px dashed #e2e8f0; padding-bottom: 5px;">
                    <strong>${index + 1}. ${item.name}</strong> <em>(${item.supplier})</em><br>
                    <span style="color:#f87171; font-weight:700;">+${item.pctFormatted}%</span> 
                    <span style="color:#94a3b8; font-size:0.75rem;">(৳${item.prevPrice.toFixed(2)} → ৳${item.latestPrice.toFixed(2)})</span>
                </div>
            `;
        });
        htmlList += `</div>`;

        priceContainer.innerHTML = htmlList;
        actionContainer.innerHTML = `
            <button class="btn btn-sm btn-outline" style="color:var(--color-primary); border-color:rgba(59,130,246,0.35); background:rgba(59,130,246,0.06); font-size:0.8rem; width:100%; justify-content:center;" onclick="openComparePricesModal()">
                <i class="fas fa-balance-scale"></i> Compare All (${priceHikes.length} Hike${priceHikes.length > 1 ? 's' : ''})
            </button>
        `;
    }

    // -------------------------------------------------------------------
    // 2. CASH FLOW FORECAST (NEXT 7 DAYS VS NEXT 30 DAYS)
    // -------------------------------------------------------------------
    const now = new Date();
    const day7Limit = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const day30Limit = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    let unpaid7Days = 0;
    let unpaid30Days = 0;

    deliveries.forEach(d => {
        const isUnpaid = (d.status === 'Delivered' || d.status === 'Partial Delivery') && d.payment_status !== 'Paid';
        if (isUnpaid) {
            const amount = d.total_amount || 0;
            const deliveryDate = d.scheduled_date?.toDate?.() || now;

            if (deliveryDate <= day7Limit) unpaid7Days += amount;
            if (deliveryDate <= day30Limit) unpaid30Days += amount;
        }
    });

    document.getElementById('ai-insight-cash').innerHTML = `
        Upcoming Unpaid Liabilities:<br>
        • Next 7 Days: <strong style="color:#f59e0b;">৳${unpaid7Days.toFixed(2)}</strong><br>
        • Next 30 Days: <strong style="color: var(--sidebar-bg);">৳${unpaid30Days.toFixed(2)}</strong>
    `;

    document.getElementById('ai-cash-action').innerHTML = `
        <button class="btn btn-sm btn-outline" style="color:var(--color-primary); border-color:rgba(59,130,246,0.35); background:rgba(59,130,246,0.06); font-size:0.8rem; width:100%; justify-content:center;" onclick="openPayableScheduleModal()">
            <i class="fas fa-calendar-alt"></i> Export Payable Schedule
        </button>
    `;

    // -------------------------------------------------------------------
    // 3. WASTE & DISCREPANCIES (IMPACT SCORE IN TAKA & DIRECT CONTACT)
    // -------------------------------------------------------------------
    // 3. WASTE & DISCREPANCIES (MULTI-VENDOR IMPACT BREAKDOWN)
    const supplierLossMap = {};
    window._aiDiscrepancyList = [];

    deliveries.forEach(d => {
        if (d.status === 'Partial Delivery' || d.status === 'Not Delivered') {
            // Fallback chain for display name only — never expose a raw Firestore
            // document ID, and never mislabel an unrelated supplier with a fixed name.
            const supplier = d.supplier_name || (d.supplier_email ? d.supplier_email.split('@')[0] : '') || 'Unknown Supplier';
            // Group by a stable key so two different unnamed suppliers don't get merged together.
            const groupKey = d.supplier_id || d.supplier_email || supplier;
            // Deliveries only ever store supplier_id, never an email — look the real
            // email up from the suppliers collection cache (populated by listenSuppliersAndUsers).
            const supplierRecord = (window._suppliersCache || []).find(s => s.id === d.supplier_id);
            const email = supplierRecord?.email || d.supplier_email || '';
            const unfulfilledLoss = Number(d.total_amount || 0);

            if (!supplierLossMap[groupKey]) {
                supplierLossMap[groupKey] = { name: supplier, loss: 0, count: 0, email: email, orders: [] };
            }
            supplierLossMap[groupKey].loss += unfulfilledLoss;
            supplierLossMap[groupKey].count++;
            supplierLossMap[groupKey].orders.push(d.order_id || d.id);
        }
    });

    const discrepancyList = Object.values(supplierLossMap);
    discrepancyList.sort((a, b) => b.loss - a.loss); // Highest loss first
    window._aiDiscrepancyList = discrepancyList;

    const wasteContainer = document.getElementById('ai-insight-waste');
    const wasteAction = document.getElementById('ai-waste-action');

    if (discrepancyList.length === 0 || discrepancyList.every(i => i.loss === 0)) {
        wasteContainer.innerHTML = `
            <div style="font-size:0.9rem; color:var(--color-success);">
                <i class="fas fa-shield-check"></i> ৳0.00 lost to unfulfilled stock. All vendors maintaining 100% completion rates.
            </div>`;
        wasteAction.innerHTML = '';
    } else {
        // Each supplier gets its own row with a Contact button on the right,
        // wired to that row's own email — not just the single worst offender.
        let htmlList = ``;
        discrepancyList.forEach((item, idx) => {
            const hasValidEmail = isValidEmail(item.email);
            const safeName = escapeForAttr(item.name);
            const safeEmail = escapeForAttr(item.email);
            const contactBtn = hasValidEmail
                ? `<button class="btn-contact-row" onclick="contactSupplierNow('${safeEmail}', '${safeName}')">
                       <i class="fas fa-paper-plane"></i> Contact
                   </button>`
                : `<button class="btn-contact-row" disabled title="No email on file for this supplier">
                       <i class="fas fa-paper-plane"></i> Contact
                   </button>`;

            htmlList += `
                <div class="discrepancy-row">
                    <div class="discrepancy-info">
                        <strong>${idx + 1}. ${item.name}</strong><br>
                        <span style="color:#64748b; font-size:0.78rem;">${item.count} order(s) partial/unfulfilled</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span class="discrepancy-loss">৳${item.loss.toFixed(2)}</span>
                        ${contactBtn}
                    </div>
                </div>
            `;
        });

        wasteContainer.innerHTML = htmlList;
        wasteAction.innerHTML = '';
    }
}

// --- MODAL INTERACTION FUNCTIONS ---
window.closeAiModal = function(id) {
    document.getElementById(id).style.display = 'none';
};

window.openComparePricesModal = function() {
    const hikes = window._aiPriceHikesList || [];
    const modal = document.getElementById('modalPriceCompare');
    document.getElementById('modalCompareTitle').innerHTML = `<i class="fas fa-balance-scale"></i> Supplier Price Hike Comparison Matrix`;

    if (hikes.length === 0) {
        document.getElementById('modalCompareBody').innerHTML = `
            <p style="color:#64748b; padding:1rem;">No price increases recorded across system logs.</p>
        `;
    } else {
        let rows = hikes.map((h, i) => `
            <tr>
                <td style="padding:8px;"><strong>${i + 1}. ${h.name}</strong></td>
                <td style="padding:8px;">${h.supplier}</td>
                <td style="padding:8px;">৳${h.prevPrice.toFixed(2)}</td>
                <td style="padding:8px;">৳${h.latestPrice.toFixed(2)}</td>
                <td style="padding:8px;"><strong style="color:#ef4444;">+${h.pctFormatted}%</strong></td>
            </tr>
        `).join('');

        document.getElementById('modalCompareBody').innerHTML = `
            <div style="max-height: 350px; overflow-y: auto;">
                <table class="table" style="width:100%; text-align:left; font-size:0.85rem; border-collapse:collapse;">
                    <thead>
                        <tr style="border-bottom:2px solid #cbd5e1; background:#f8fafc; color:#0f172a;">
                            <th style="padding:8px;">Item</th>
                            <th style="padding:8px;">Supplier</th>
                            <th style="padding:8px;">Prev Price</th>
                            <th style="padding:8px;">New Price</th>
                            <th style="padding:8px;">Increase</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
            <p style="font-size:0.75rem; color:#64748b; margin-top:10px;">
                Showing ${hikes.length} total price hike anomaly item(s) retrieved from system records.
            </p>
        `;
    }
    modal.style.display = 'flex';
};

window.openPayableScheduleModal = function() {
    const modal = document.getElementById('modalPayableSchedule');
    const grouped = window._ownerDeliveriesGrouped || {};

    const unpaidOrders = [];

    // Process grouped orders to calculate true remaining balances
    Object.entries(grouped).forEach(([orderId, items]) => {
        const isPaid = items.some(i => i.payment_status === 'Paid');
        const totalAmount = items.reduce((sum, i) => sum + (i.total_amount || 0), 0);

        // ONLY include orders that are UNPAID and have a total balance > 0
        if (!isPaid && totalAmount > 0) {
            unpaidOrders.push({
                orderId: orderId,
                supplier: items[0]?.supplier_name || items[0]?.supplier_email || '—',
                date: items[0]?.scheduled_date?.toDate?.() || null,
                amount: totalAmount,
                status: items[0]?.payment_status || 'Unpaid'
            });
        }
    });

    // Sort unpaid orders descending (newest first)
    unpaidOrders.sort((a, b) => {
        const dateA = a.date ? a.date.getTime() : 0;
        const dateB = b.date ? b.date.getTime() : 0;
        return dateB - dateA;
    });

    if (unpaidOrders.length === 0) {
        document.getElementById('modalScheduleBody').innerHTML = `
            <div style="text-align:center; padding:2rem; color:#10b981;">
                <i class="fas fa-circle-check" style="font-size:2rem; margin-bottom:0.5rem;"></i>
                <p style="font-weight:600; margin:0;">All clear! You have no upcoming unpaid liabilities.</p>
            </div>
        `;
    } else {
        let rows = unpaidOrders.map(u => `
            <tr>
                <td style="padding:10px 8px;"><strong>${u.orderId}</strong></td>
                <td style="padding:10px 8px;">${u.supplier}</td>
                <td style="padding:10px 8px;">${u.date ? u.date.toLocaleDateString() : '—'}</td>
                <td style="padding:10px 8px;"><span class="badge" style="background:#fef3c7; color:#92400e; font-size:0.75rem;">${u.status}</span></td>
                <td style="padding:10px 8px; text-align:right;"><strong style="color:#ef4444;">৳${u.amount.toFixed(2)}</strong></td>
            </tr>
        `).join('');

        document.getElementById('modalScheduleBody').innerHTML = `
            <div style="max-height: 350px; overflow-y: auto;">
                <table class="table" style="width:100%; text-align:left; font-size:0.85rem; border-collapse:collapse;">
                    <thead>
                        <tr style="border-bottom:2px solid #cbd5e1; background:#f8fafc; color:#0f172a;">
                            <th style="padding:8px;">Order Ref</th>
                            <th style="padding:8px;">Supplier</th>
                            <th style="padding:8px;">Scheduled Date</th>
                            <th style="padding:8px;">Status</th>
                            <th style="padding:8px; text-align:right;">Balance Owed</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
            <div style="margin-top:12px; font-size:0.8rem; color:#64748b; display:flex; justify-space-between;">
                <span>Total Liabilities: <strong>${unpaidOrders.length} Order(s)</strong></span>
            </div>
        `;
    }

    modal.style.display = 'flex';
};

window.openContactModal = function(email, name) {
    document.getElementById('contactModalEmail').value = email;
    document.getElementById('contactModalSubject').value = `Urgent: Unfulfilled Stock Discrepancy Inquiry - ${name}`;
    document.getElementById('contactModalBody').value = `Dear ${name},\n\nWe noted multiple unfulfilled or partial deliveries logged in our system recently. Please let us know when we can expect full reconciliation for these items.\n\nRegards,\nManagement`;
    document.getElementById('modalContactSupplier').style.display = 'flex';
};

window.sendSupplierEmail = function() {
    const email = document.getElementById('contactModalEmail').value;
    const subject = encodeURIComponent(document.getElementById('contactModalSubject').value);
    const body = encodeURIComponent(document.getElementById('contactModalBody').value);

    window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
    closeAiModal('modalContactSupplier');
};

// Basic sanity check so we never build a mailto: link from a placeholder/missing address
function isValidEmail(email) {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Escapes a string for safe use inside a single-quoted HTML attribute (onclick="...")
function escapeForAttr(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;')
        .replace(/"/g, '&quot;');
}

// Per-row "Contact" button handler — opens the default mail client directly,
// no confirmation modal, same immediate mailto behavior used across the app.
window.contactSupplierNow = function(email, name) {
    if (!isValidEmail(email)) {
        alert(`No valid email on file for ${name}. Please update the supplier record first.`);
        return;
    }
    const subject = encodeURIComponent(`Urgent: Unfulfilled Stock Discrepancy Inquiry - ${name}`);
    const body = encodeURIComponent(
        `Dear ${name},\n\nWe noted multiple unfulfilled or partial deliveries logged in our system recently. Please let us know when we can expect full reconciliation for these items.\n\nRegards,\nManagement`
    );
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${subject}&body=${body}`;
    window.open(gmailUrl, '_blank');
};
//-------------------------------------------------------------------------------

    function switchWorkspace(panelId, menuId) {
    document.querySelectorAll('.workspace').forEach(v => v.classList.remove('active-view'));
    document.getElementById(panelId).classList.add('active-view');
    document.querySelectorAll('.sidebar-menu li').forEach(li => li.classList.remove('active'));
    document.getElementById(menuId).classList.add('active');
    document.getElementById('viewHeaderTitle').textContent =
        document.getElementById(menuId).innerText.trim();

    // Re-render chart when entering reports view to fix layout calculation bugs
    if (panelId === 'reportsView') {
        setTimeout(() => {
            if (typeof renderAnalyticsChart === 'function') {
                renderAnalyticsChart();
            }
        }, 100);
    }
}
window.switchWorkspace = switchWorkspace;

    // ── Dashboard metrics + Payments ledger, sourced from 'deliveries' ──
    // onSnapshot is only ever attached ONCE (guarded below). The date-range
    // dropdown no longer re-subscribes to Firestore — it just re-runs the
    // calculation against the last cached snapshot. See refreshDashboardKPIs().
    function listenDeliveries() {
    if (window._deliveriesListenerAttached) {
        if (window._ownerDeliveriesRaw) {
            computeAndRenderKPIs(window._ownerDeliveriesRaw);
        }
        return;
    }
    window._deliveriesListenerAttached = true;

    onSnapshot(collection(db, 'deliveries'), (snapshot) => {
        const deliveries = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        window._ownerDeliveriesRaw = deliveries; // cache raw docs for filter re-runs

        generateAiStrategicInsights(deliveries);
        renderAnalyticsChart(deliveries);

        computeAndRenderKPIs(deliveries);
    });
}

// Pulled out of the onSnapshot callback so the dropdown filter can re-run
// this against cached data without opening a new Firestore listener.
function computeAndRenderKPIs(deliveries) {
        const grouped = {};
        deliveries.forEach(d => {
            const key = d.order_id || d.id;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(d);
        });
        window._ownerDeliveriesGrouped = grouped;

        let totalSpend = 0, outstanding = 0, settledCount = 0, pendingCount = 0;
        const orderSummaries = [];

        // 1. Read selected timeframe from dropdown (defaults to 'thisMonth')
        const range = document.getElementById('kpiDateRangeSelect')?.value || 'thisMonth';
        const now = new Date();
        let startDate;
        let endDate = new Date(8640000000000000); // no upper bound by default

        if (range === 'thisMonth') {
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        } else if (range === '30days') {
            startDate = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
        } else if (range === 'prevMonth') {
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            endDate   = new Date(now.getFullYear(), now.getMonth(), 1);
        } else if (range === 'thisYear') {
            startDate = new Date(now.getFullYear(), 0, 1);
        } else { // 'all'
            startDate = new Date(0); // Epoch start (1970)
        }

        Object.entries(grouped).forEach(([orderId, items]) => {
            const allDelivered = items.every(i =>
                i.status === 'Delivered' || i.status === 'Partial Delivery' || i.status === 'Not Delivered');
            const total = items.reduce((sum, i) => sum + (i.total_amount || 0), 0);
            const isPaid = items.some(i => i.payment_status === 'Paid');
            const pendingCash = items.some(i => i.payment_status === 'Pending Cash Confirmation');

            // 2. Safely parse scheduled date
            const orderDate = items[0]?.scheduled_date?.toDate?.() || new Date(0);

            if (isPaid) {
                // Filter Settled Spend & Settled Count based on selected timeframe
                if (orderDate >= startDate && orderDate < endDate) {
                    totalSpend += total;
                    settledCount++;
                }
            } else if (allDelivered && total > 0) {
                // Keep Outstanding Liabilities & Pending Count ALL-TIME (Active liabilities)
                outstanding += total;
                pendingCount++;
            }

            if (allDelivered && total > 0) {
                orderSummaries.push({
                    orderId, items, total,
                    supplierName: items[0]?.supplier_name || '—',
                    date: items[0]?.scheduled_date?.toDate?.() || null,
                    isPaid, pendingCash
                });
            }
        });

        document.getElementById('kpi-total-spend').textContent  = `৳${totalSpend.toFixed(2)}`;
        document.getElementById('kpi-outstanding').textContent  = `৳${outstanding.toFixed(2)}`;
        document.getElementById('kpi-settled').textContent      = settledCount;
        document.getElementById('kpi-pending-count').textContent = pendingCount;

        // Sort orders so the most recent dates appear at the top
        orderSummaries.sort((a, b) => {
            const dateA = a.date ? a.date.getTime() : 0;
            const dateB = b.date ? b.date.getTime() : 0;
            return dateB - dateA; // Descending order (newest first)
        });

        populatePaymentsTable(orderSummaries);
}

// Called when the dropdown changes. Re-runs against cached data — no new
// Firestore listener gets created.
window.refreshDashboardKPIs = function() {
    if (window._ownerDeliveriesRaw) {
        computeAndRenderKPIs(window._ownerDeliveriesRaw);
    }
};

    window.populatePaymentsTable = function(orders) {
    const tbody = document.getElementById('payments-tbody');
    if (!tbody) return;

    if (orders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6">No fulfilled orders yet.</td></tr>';
        return;
    }

    tbody.innerHTML = orders.map(o => {
        let badge, actionBtn;
        
        // Grab the exact order reference ID key
        const targetOrderId = o.orderId || o.order_id || o.id;

        if (o.isPaid) {
            badge = '<span class="badge badge-success">Paid</span>';
            actionBtn = `<button class="btn btn-sm btn-outline" onclick="window.openInvoiceDetailsModal('${targetOrderId}')"><i class="fas fa-check"></i> Settled</button>`;
        } else if (o.pendingCash) {
            badge = '<span class="badge badge-warning">Awaiting Cash Confirmation</span>';
            actionBtn = '<button class="btn btn-sm btn-outline" disabled><i class="fas fa-hourglass-half"></i> Pending</button>';
        } else {
            badge = '<span class="badge badge-danger">Unpaid Invoice</span>';
            actionBtn = `<button class="btn btn-sm btn-primary" onclick="window.openInvoiceDetailsModal('${targetOrderId}')" title="View details for order ${targetOrderId}">
                            <i class="fas fa-eye"></i> View Only</button>`;
        }

        const dateStr = o.date ? o.date.toLocaleDateString() : '—';

        return `
        <tr>
            <td><strong>${targetOrderId}</strong></td>
            <td>${o.supplierName}</td>
            <td>${dateStr}</td>
            <td><strong>৳${o.total.toFixed(2)}</strong></td>
            <td>${badge}</td>
            <td style="text-align:right;">${actionBtn}</td>
        </tr>`;
    }).join('');
};

    // ── RBAC — read-only view of manager + suppliers ──
    function listenSuppliersAndUsers() {
        onSnapshot(collection(db, 'suppliers'), (snapshot) => {
            const suppliers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            window._suppliersCache = suppliers;
            populateRbacTable(suppliers);
            // Deliveries never store a supplier email directly — only supplier_id.
            // Re-render insights now that we have supplier records to look emails up from.
            if (window._aiDeliveriesCache && window._aiDeliveriesCache.length) {
                generateAiStrategicInsights(window._aiDeliveriesCache);
            }
        });
    }

    function populateRbacTable(suppliers) {
    const tbody = document.getElementById('rbac-tbody');
    if (!tbody) return;

    // Define fixed staff accounts with their correct email addresses
    const MANAGER_EMAIL = 'jamee9325@gmail.com';
    const CHEF_EMAIL    = '68jamee@gmail.com';

    const rows = [
        `<tr>
            <td><strong>Restaurant Manager</strong></td>
            <td>${MANAGER_EMAIL}</td>
            <td><span class="badge badge-warning">MANAGER</span></td>
            <td style="text-align:right;"><span class="text-muted small-text">Fixed role</span></td>
        </tr>`,
        `<tr>
            <td><strong>Kitchen Staff Line 1</strong></td>
            <td>${CHEF_EMAIL}</td>
            <td><span class="badge badge-primary">KITCHEN STAFF</span></td>
            <td style="text-align:right;"><span class="text-muted small-text">Fixed role</span></td>
        </tr>`,
        ...suppliers.map(s => `
        <tr>
            <td><strong>${s.name || '—'}</strong></td>
            <td>${s.email || '—'}</td>
            <td><span class="badge badge-success">SUPPLIER</span></td>
            <td style="text-align:right;"><span class="text-muted small-text">Managed via Manager → Suppliers</span></td>
        </tr>`)
    ];

    tbody.innerHTML = rows.join('');
}

        //------------------------------------
        // Global Chart variable reference
let analyticsChart = null;

function renderAnalyticsChart(deliveries) {
    // Cache deliveries array globally if passed
    if (deliveries) {
        window._aiDeliveriesCache = deliveries;
    }

    const canvas = document.getElementById('liveAnalyticsChart');
    if (!canvas) return;

    // Retrieve deliveries from cache if not directly provided
    const dataToUse = deliveries || window._aiDeliveriesCache || [];

    let totalPaid = 0;
    let totalUnpaid = 0;

    dataToUse.forEach(d => {
        const total = d.total_amount || 0;
        if (d.payment_status === 'Paid') {
            totalPaid += total;
        } else if (d.status === 'Delivered' || d.status === 'Partial Delivery') {
            totalUnpaid += total;
        }
    });

    // Check if Chart.js CDN is loaded
    if (typeof Chart === 'undefined') {
        console.error('Chart.js CDN is missing in <head>!');
        return;
    }

    const ctx = canvas.getContext('2d');

    if (analyticsChart) {
        analyticsChart.destroy();
    }

    analyticsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Total Settled Spend', 'Outstanding Liabilities'],
            datasets: [{
                label: 'Financial Breakdown (৳)',
                data: [totalPaid, totalUnpaid],
                backgroundColor: ['#10b981', '#ef4444'],
                borderRadius: 6,
                barThickness: 50
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) { return '৳' + value; }
                    }
                }
            }
        }
    });
}
window.renderAnalyticsChart = renderAnalyticsChart;
//--------------------------------Reports PDF-------------------------------
// Helper: Filter deliveries array by selected date range
function getFilteredDeliveries() {
    const range = document.getElementById('exportDateRange')?.value || 'all';
    const deliveries = window._aiDeliveriesCache || [];
    if (range === 'all') return deliveries;

    const now = new Date();
    return deliveries.filter(d => {
        const itemDate = d.scheduled_date?.toDate?.() || new Date(0);
        if (range === 'today') {
            return itemDate.toDateString() === now.toDateString();
        } else if (range === '7days') {
            const diffDays = (now - itemDate) / (1000 * 3600 * 24);
            return diffDays <= 7;
        } else if (range === 'month') {
            return itemDate.getMonth() === now.getMonth() && itemDate.getFullYear() === now.getFullYear();
        }
        return true;
    });
}

// 1. Clean PDF Export (Captures real KPI totals properly)
window.exportStoreReportPDF = function() {
    const rangeLabel = document.getElementById('exportDateRange').options[document.getElementById('exportDateRange').selectedIndex].text;
    const filteredData = getFilteredDeliveries();

    let totalSpend = 0, outstanding = 0, settledCount = 0;
    filteredData.forEach(d => {
        const total = Number(d.total_amount || 0);
        if (d.payment_status === 'Paid') {
            totalSpend += total;
            settledCount++;
        } else if (d.status === 'Delivered' || d.status === 'Partial Delivery') {
            outstanding += total;
        }
    });

    const element = document.createElement('div');
    element.style.padding = '25px';
    element.style.fontFamily = 'Arial, sans-serif';
    element.style.color = '#0f172a';

    element.innerHTML = `
        <div style="border-bottom: 2px solid #3b82f6; padding-bottom: 10px; margin-bottom: 20px;">
            <h2 style="margin:0; color:#0f172a;">Restaurant IMS - Executive Financial Summary</h2>
            <p style="margin:4px 0 0 0; color:#64748b; font-size:0.85rem;">
                Filter Applied: <strong>${rangeLabel}</strong> | Date Generated: ${new Date().toLocaleDateString()}
            </p>
        </div>
        <table style="width:100%; border-collapse:collapse; margin-top:15px; font-size:0.95rem;">
            <tr style="border-bottom: 1px solid #e2e8f0; height: 35px;">
                <td><strong>Total Store Spending (Settled):</strong></td>
                <td style="text-align:right; color:#10b981; font-weight:700;">৳${totalSpend.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #e2e8f0; height: 35px;">
                <td><strong>Outstanding Owed Liabilities:</strong></td>
                <td style="text-align:right; color:#ef4444; font-weight:700;">৳${outstanding.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #e2e8f0; height: 35px;">
                <td><strong>Procured Invoices Settled:</strong></td>
                <td style="text-align:right; font-weight:700;">${settledCount}</td>
            </tr>
            <tr style="border-bottom: 1px solid #e2e8f0; height: 35px;">
                <td><strong>Total Records Audited:</strong></td>
                <td style="text-align:right; font-weight:700;">${filteredData.length} item(s)</td>
            </tr>
        </table>
    `;

    const opt = {
        margin:       0.5,
        filename:     `Financial_Report_${new Date().toISOString().slice(0,10)}.pdf`,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2 },
        jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };

    html2pdf().set(opt).from(element).save();
};

// 2. Excel-Formatted Clean CSV Export
window.exportSupplierDataCSV = function() {
    const deliveries = getFilteredDeliveries();
    if (deliveries.length === 0) {
        alert("No records found for the selected date range.");
        return;
    }

    // Add UTF-8 BOM byte (\uFEFF) so Microsoft Excel opens special characters and columns cleanly
    let csvRows = ["\uFEFFOrder ID,Supplier Name,Ingredient Name,Quantity,Unit Price (BDT),Total Amount (BDT),Fulfillment Status,Payment Status,Scheduled Date"];

    deliveries.forEach(d => {
        const dateStr = d.scheduled_date?.toDate?.() ? d.scheduled_date.toDate().toLocaleDateString() : '—';
        const row = [
            `"${d.order_id || d.id || ''}"`,
            `"${d.supplier_name || d.supplier_email || 'Unassigned'}"`,
            `"${d.ingredient_name || ''}"`,
            d.quantity || 1,
            d.unit_price || 0,
            d.total_amount || 0,
            `"${d.status || ''}"`,
            `"${d.payment_status || 'Unpaid'}"`,
            `"${dateStr}"`
        ].join(",");
        csvRows.push(row);
    });

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    
    link.setAttribute("href", url);
    link.setAttribute("download", `Supplier_Ledger_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};