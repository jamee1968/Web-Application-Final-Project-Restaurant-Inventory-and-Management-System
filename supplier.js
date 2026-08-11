// ============================================================
//  supplier.js  —  Restaurant IMS | Supplier Portal Module
// ============================================================

import {
    collection, doc, getDocs,
    onSnapshot, updateDoc,
    query, where,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import { getAuth, onAuthStateChanged, signOut }
    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

let db;
try {
    ({ db } = await import('./firebase-config.js'));
} catch (err) {
    console.error('🔥 Firebase failed to initialize:', err);
    alert('Could not connect to the database.');
}

const auth = getAuth();
let mySupplierId   = null;
let mySupplierName = null;

// ============================================================
//  AUTH GUARD
// ============================================================

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        const q = query(collection(db, 'suppliers'), where('auth_uid', '==', user.uid));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            alert('This account is not registered as a supplier.');
            await signOut(auth);
            window.location.href = 'index.html';
            return;
        }

        const supplierDoc = snapshot.docs[0];
        mySupplierId   = supplierDoc.id;
        mySupplierName = supplierDoc.data().name || 'Supplier';

        document.getElementById('supplier-name-label').textContent = mySupplierName;
        document.getElementById('supplier-id-label').textContent   = `ID: ${mySupplierId.slice(0, 8).toUpperCase()}`;

        listenMyOrders();

    } catch (err) {
        console.error('Supplier auth check failed:', err);
        window.location.href = 'index.html';
    }
});

async function handleSupplierLogout() {
    await signOut(auth);
    window.location.href = 'index.html';
}
window.handleSupplierLogout = handleSupplierLogout;

// ============================================================
//  UNIFIED ORDERS TABLE — sourced from 'deliveries' collection
//  (covers Pending → Shipped → Delivered/Partial, plus invoicing)
// ============================================================

function listenMyOrders() {
    const q = query(collection(db, 'deliveries'), where('supplier_id', '==', mySupplierId));

    onSnapshot(q, (snapshot) => {
        const orders = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        orders.sort((a, b) => (b.scheduled_date?.seconds || 0) - (a.scheduled_date?.seconds || 0));
        populateOrdersTable(orders);
    }, (error) => {
        console.error('My Orders listener error:', error);
        document.getElementById('orders-tbody').innerHTML =
            `<tr><td colspan="5">Error loading orders. Check console — a Firestore index may need to be created (see the link in the error).</td></tr>`;
    });
}

function populateOrdersTable(orders) {
    const tbody = document.getElementById('orders-tbody');
    if (!tbody) return;

    if (orders.length === 0) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="5">No orders yet.</td></tr>';
        return;
    }

    const grouped = {};
    orders.forEach(o => {
        const key = o.order_id || o.id;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(o);
    });

    window._ordersGroupedCache = grouped;

    tbody.innerHTML = Object.entries(grouped).map(([orderId, items]) => {
        const allDelivered = items.every(i => i.status === 'Delivered' || i.status === 'Partial Delivery');
        const anyPending    = items.some(i => i.status === 'Pending');
        const allInvoiced   = items.every(i => i.invoice_submitted);

        const paidItem = items.find(i => i.payment_status === 'Paid');

        let badgeClass = 'badge-warning', statusLabel = 'Pending', rowClass = 'row-status-pending';
        if (allDelivered && paidItem) {
            badgeClass = 'badge-success';
            statusLabel = paidItem.payment_method === 'Cash' ? 'Paid (Cash)' : 'Paid (Online)';
            rowClass = 'row-status-delivered';
        } else if (allDelivered) {
            badgeClass = 'badge-success'; statusLabel = 'Delivered'; rowClass = 'row-status-delivered';
        } else if (!anyPending) {
            badgeClass = 'badge-primary'; statusLabel = 'Shipped'; rowClass = 'row-status-shipped';
        }

        const itemsList = items.map(i =>
            `${i.ingredient_name}: ${i.ordered_quantity}${i.ingredient_unit ? ' ' + i.ingredient_unit : ''}`
        ).join(', ');

        const anyPaid        = items.some(i => i.payment_status === 'Paid');
        const anyPendingCash = items.some(i => i.payment_status === 'Pending Cash Confirmation');

        let actionBtn;
        if (anyPending) {
            actionBtn = `<button class="btn btn-sm btn-success" onclick="openShipModal('${orderId}')">
                            <i class="fas fa-shipping-fast"></i> Confirm Shipment</button>`;
        } else if (!allDelivered) {
            actionBtn = `<button class="btn btn-sm btn-outline" disabled>
                            <i class="fas fa-clock"></i> Awaiting Confirmation</button>`;
        } else if (allDelivered && anyPendingCash) {
            actionBtn = `<button class="btn btn-sm btn-warning" onclick="confirmCashReceived('${orderId}')" style="background:#f59e0b; color:#fff;">
                            <i class="fas fa-money-bill-wave"></i> Confirm Cash Received</button>`;
        } else if (allDelivered && anyPaid) {
            actionBtn = `<button class="btn btn-sm btn-outline" disabled><i class="fas fa-lock"></i> Paid</button>`;
        } else {
            actionBtn = `<button class="btn btn-sm btn-outline" disabled><i class="fas fa-lock"></i> Closed</button>`;
        }

        return `
        <tr class="${rowClass}">
            <td><strong>${orderId}</strong></td>
            <td>${itemsList}</td>
            <td>${items.length} item${items.length>1?'s':''}</td>
            <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
            <td style="text-align: right;">${actionBtn}</td>
        </tr>`;
    }).join('');
}

// ============================================================
//  SHIPMENT CONFIRMATION — supplier declares actual quantity sent
// ============================================================

function openShipModal(orderId) {
    const items = (window._ordersGroupedCache || {})[orderId] || [];
    if (items.length === 0) return;

    window._shipItemsContext = items;

    const rows = items.map((item, idx) => `
        <tr>
            <td>${item.ingredient_name}</td>
            <td>${item.ordered_quantity} ${item.ingredient_unit || ''}</td>
            <td style="text-align:center;">
                <input type="checkbox" class="ship-full-checkbox" data-index="${idx}" onchange="toggleShipFull(${idx})">
            </td>
            <td>
                <input type="number" class="form-control ship-qty-input" data-index="${idx}" min="0"
                       placeholder="0" oninput="updateShipmentTotal()">
            </td>
            <td>
                <input type="number" class="form-control ship-price-input" data-index="${idx}" min="0" step="0.01"
                       placeholder="0.00" oninput="updateShipmentTotal()">
            </td>
            <td class="ship-line-total text-muted" data-index="${idx}">৳ 0.00</td>
        </tr>`).join('');

    const box = document.getElementById('shipModal').querySelector('.modal-box');
    box.innerHTML = `
        <h3 class="mb-1"><i class="fas fa-shipping-fast"></i> Prepare Shipment — ${orderId}</h3>
        <p class="modal-note">Check "Full" to ship the exact ordered amount, or type the quantity you're actually sending. Enter the unit price for each item — totals are calculated automatically.</p>
        <table class="delivery-summary-table">
            <thead>
                <tr><th>Item</th><th>Ordered</th><th>Full</th><th>Shipping Qty</th><th>Unit Price</th><th>Line Total</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        <div class="form-group" style="text-align:right; margin-top:1rem;">
            <label style="font-weight:700;">Grand Total: <span id="ship-grand-total">৳ 0.00</span></label>
        </div>
        <div class="modal-footer">
            <button class="btn btn-outline" onclick="closeShipModal()">Cancel</button>
            <button class="btn btn-success" onclick="submitShipment('${orderId}')">
                <i class="fas fa-check"></i> Confirm Shipment
            </button>
        </div>
    `;
    document.getElementById('shipModal').style.display = 'flex';
}
window.openShipModal = openShipModal;


//----------------------------------------------------------------------
function toggleShipFull(idx) {
    const checkbox = document.querySelector(`.ship-full-checkbox[data-index="${idx}"]`);
    const input    = document.querySelector(`.ship-qty-input[data-index="${idx}"]`);
    const item     = window._shipItemsContext[idx];

    if (checkbox.checked) {
        input.value = item.ordered_quantity;
        input.disabled = true;
    } else {
        input.disabled = false;
    }

    updateShipmentTotal();
}
window.toggleShipFull = toggleShipFull;

//------------------------------------------------------------------------
function updateShipmentTotal() {
    let grandTotal = 0;

    document.querySelectorAll('.ship-qty-input').forEach(qtyInput => {
        const idx   = qtyInput.dataset.index;
        const qty   = parseFloat(qtyInput.value) || 0;
        const priceInput = document.querySelector(`.ship-price-input[data-index="${idx}"]`);

        if (qty === 0 && qtyInput.value.trim() !== '') {
            priceInput.value = '0';
            priceInput.disabled = true;
        } else {
            priceInput.disabled = false;
        }

        const price = parseFloat(priceInput.value) || 0;
        const lineTotal = qty * price;

        const lineTotalCell = document.querySelector(`.ship-line-total[data-index="${idx}"]`);
        if (lineTotalCell) lineTotalCell.textContent = `৳ ${lineTotal.toFixed(2)}`;

        grandTotal += lineTotal;
    });

    const grandTotalEl = document.getElementById('ship-grand-total');
    if (grandTotalEl) grandTotalEl.textContent = `৳ ${grandTotal.toFixed(2)}`;
}
window.updateShipmentTotal = updateShipmentTotal;
//--------------------------------------------------------------------

function closeShipModal() {
    document.getElementById('shipModal').style.display = 'none';
    window._shipItemsContext = null;
}
window.closeShipModal = closeShipModal;
//----------------------------------------------------

async function submitShipment(orderId) {
    const items = window._shipItemsContext || [];
    const missing = [];

    // First pass — validate everything before writing anything to Firestore
    for (let idx = 0; idx < items.length; idx++) {
        const fullCheckbox = document.querySelector(`.ship-full-checkbox[data-index="${idx}"]`);
        const qtyInput      = document.querySelector(`.ship-qty-input[data-index="${idx}"]`);
        const priceInput    = document.querySelector(`.ship-price-input[data-index="${idx}"]`);

        const isChecked = fullCheckbox.checked;
        const qtyRaw     = qtyInput.value.trim();
        const priceRaw   = priceInput.value.trim();
        const qty        = parseFloat(qtyRaw);
        const price       = parseFloat(priceRaw);

        // Must either check "Full", or explicitly type a Shipping Qty (including 0) — blank is not allowed
        if (!isChecked && qtyRaw === '') {
            missing.push(`${items[idx].ingredient_name}: please check "Full" or type a Shipping Qty (0 if you don't have it).`);
            continue;
        }

        const effectiveQty = isChecked ? items[idx].ordered_quantity : qty;

        if (isNaN(effectiveQty) || effectiveQty < 0) {
            missing.push(`${items[idx].ingredient_name}: invalid Shipping Qty.`);
            continue;
        }

        // If shipping 0, unit price is forced to 0 automatically — no price needed
        if (effectiveQty === 0) {
            continue;
        }

        // If shipping any positive quantity, unit price is required
        if (priceRaw === '' || isNaN(price) || price <= 0) {
            missing.push(`${items[idx].ingredient_name}: please enter a valid unit price.`);
        }
    }

    if (missing.length > 0) {
        alert('Please complete the following before confirming shipment:\n\n' + missing.join('\n'));
        return;
    }

    try {
        for (let idx = 0; idx < items.length; idx++) {
            const fullCheckbox = document.querySelector(`.ship-full-checkbox[data-index="${idx}"]`);
            const qtyInput      = document.querySelector(`.ship-qty-input[data-index="${idx}"]`);
            const priceInput    = document.querySelector(`.ship-price-input[data-index="${idx}"]`);

            const isChecked = fullCheckbox.checked;
            const qty = isChecked ? items[idx].ordered_quantity : (parseFloat(qtyInput.value) || 0);
            const price = (qty === 0) ? 0 : (parseFloat(priceInput.value) || 0);
            const total = qty * price;

            await updateDoc(doc(db, 'deliveries', items[idx].id), {
                shipped_quantity: qty,
                unit_price: price,
                total_amount: total,
                invoice_submitted: qty > 0,
                status: 'Shipped',
                shipped_date: serverTimestamp()
            });
        }
        alert('Shipment confirmed! The manager can now see what you\'re sending and the price.');
        closeShipModal();
    } catch (err) {
        console.error('Failed to confirm shipment:', err);
        alert('Failed to confirm shipment.');
    }
}
window.submitShipment = submitShipment;



// ============================================================
//  INVOICE SUBMISSION
// ============================================================

let invoiceOrderItems = [];

function openInvoiceModal(orderId) {
    invoiceOrderItems = (window._ordersGroupedCache || {})[orderId] || [];
    if (invoiceOrderItems.length === 0) return;

    const box = document.getElementById('invoiceModal').querySelector('.modal-box');
    const rows = invoiceOrderItems.map((item, idx) => `
        <div class="form-group">
            <label>${item.ingredient_name} (Qty: ${item.ordered_quantity} ${item.ingredient_unit || ''})</label>
            <input type="number" class="form-control invoice-unit-price" min="0" step="0.01"
                   data-index="${idx}" oninput="updateInvoiceGrandTotal()" placeholder="Unit price (BDT)">
        </div>`).join('');

    box.innerHTML = `
        <h3 class="mb-1"><i class="fas fa-file-invoice-dollar"></i> Submit Delivery Invoice</h3>
        <p class="modal-note">Enter the price per unit for each item — total will be calculated automatically.</p>
        ${rows}
        <div class="form-group">
            <label>Grand Total</label>
            <input id="invoice-grand-total" type="text" class="form-control" disabled value="৳ 0.00">
        </div>
        <div class="modal-footer">
            <button class="btn btn-outline" onclick="closeInvoiceModal()">Cancel</button>
            <button class="btn btn-success" onclick="submitInvoice()"><i class="fas fa-check"></i> Submit Invoice</button>
        </div>
    `;

    document.getElementById('invoiceModal').style.display = 'flex';
}
window.openInvoiceModal = openInvoiceModal;

function updateInvoiceGrandTotal() {
    let total = 0;
    document.querySelectorAll('.invoice-unit-price').forEach(input => {
        const idx = parseInt(input.dataset.index);
        const price = parseFloat(input.value) || 0;
        total += price * invoiceOrderItems[idx].ordered_quantity;
    });
    document.getElementById('invoice-grand-total').value = `৳ ${total.toFixed(2)}`;
}
window.updateInvoiceGrandTotal = updateInvoiceGrandTotal;

async function submitInvoice() {
    const priceInputs = document.querySelectorAll('.invoice-unit-price');
    let allValid = true;

    priceInputs.forEach(input => {
        if (!input.value || parseFloat(input.value) <= 0) allValid = false;
    });

    if (!allValid) {
        alert('Please enter a valid unit price for every item.');
        return;
    }

    try {
        for (const input of priceInputs) {
            const idx   = parseInt(input.dataset.index);
            const item  = invoiceOrderItems[idx];
            const price = parseFloat(input.value);
            const total = price * item.ordered_quantity;

            await updateDoc(doc(db, 'deliveries', item.id), {
                unit_price: price,
                total_amount: total,
                invoice_submitted: true,
                invoice_submitted_date: serverTimestamp()
            });
        }
        alert('Invoice submitted! The manager will review and confirm receipt.');
        closeInvoiceModal();
    } catch (err) {
        console.error('Failed to submit invoice:', err);
        alert('Failed to submit invoice.');
    }
}
window.submitInvoice = submitInvoice;

function closeInvoiceModal() {
    document.getElementById('invoiceModal').style.display = 'none';
    invoiceOrderItems = [];
}
window.closeInvoiceModal = closeInvoiceModal;

//----------------------------------------------------------
// ← confirmCashReceived FUNCTION
//----------------------------------------------------------

async function confirmCashReceived(orderId) {
    const items = (window._ordersGroupedCache || {})[orderId] || [];
    try {
        for (const item of items) {
            await updateDoc(doc(db, 'deliveries', item.id), {
                payment_status: 'Paid',
                paid_date: serverTimestamp()
            });
        }
        alert('Cash payment confirmed. Thank you!');
    } catch (err) {
        console.error('Failed to confirm cash payment:', err);
        alert('Failed to confirm cash payment.');
    }
}
window.confirmCashReceived = confirmCashReceived;