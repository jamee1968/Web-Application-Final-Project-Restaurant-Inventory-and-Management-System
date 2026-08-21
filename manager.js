// ============================================================
//  manager.js  —  Restaurant IMS | Manager Dashboard Module
//  Firebase Firestore real-time integration
// ============================================================

import {
    collection, doc, getDocs, setDoc,
    onSnapshot,
    updateDoc, addDoc, increment, deleteDoc,
    query, orderBy, limit, where,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import { initializeApp, deleteApp } 
    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail, fetchSignInMethodsForEmail } 
    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

    emailjs.init('fdO0MM1dm2ijW__kd');   // ← replace with your real Public Key from EmailJS

async function sendPOEmailToSupplier(supplierEmail, supplierName, orderId, itemsSummary) {
    try {
        const result = await emailjs.send('service_qyshhhs', 'template_w1shai6', {
            to_email: supplierEmail,
            supplier_name: supplierName,
            po_id: orderId,
            items_list: itemsSummary,
            login_link: window.location.origin + '/index.html'
        });
        console.log('✅ EmailJS success:', result);
        return true;
    } catch (err) {
        console.error('❌ EmailJS send failed:', err);
        alert('Email failed to send: ' + (err.text || err.message || JSON.stringify(err)));
        return false;
    }
}

// ============================================================
//  0. FIREBASE INIT — isolated so a config error can't kill the file
// ============================================================
let pendingIngredientSelection = null;
let supplierBeingEdited = null;
let db, firebaseConfig;
try {
    ({ db, firebaseConfig } = await import('./firebase-config.js'));
} catch (err) {
    console.error('🔥 Firebase failed to initialize — check firebase-config.js:', err);
    alert('Could not connect to the database. Inventory, suppliers, and orders will not load. See console for details.');
}

// ============================================================
//  1. UI NAVIGATION
//  (switchTab now lives in a plain <script> in the HTML so it
//   works even if this Firebase module fails to load.)
// ============================================================

// ============================================================
//  2. DELIVERY MODAL CONTROLS
// ============================================================

async function receiveLogistics(orderNum) {
    const modal   = document.getElementById('deliveryModal');
    const tbody   = document.getElementById('delivery-modal-tbody');
    const titleEl = document.getElementById('deliveryModalTitle');
    const footer  = modal.querySelector('.modal-footer');

    footer.innerHTML = `
        <button class="btn btn-outline" onclick="closeDeliveryModal()" title="Cancel">Cancel</button>
        <button class="btn btn-success"
                onclick="confirmDeliveryCheckIn(document.getElementById('deliveryModal').dataset.orderNum)"
                title="Confirm and update stock">
            <i class="fas fa-check"></i> Confirm & Update Stock
        </button>`;

    modal.dataset.orderNum = orderNum;
    if (titleEl) titleEl.textContent = `Verify Delivery Manifest (PO-${orderNum})`;
    modal.querySelector('.modal-note').textContent = 'Verify or adjust actual received quantities before updating database stock.';
    tbody.innerHTML = '<tr><td colspan="6">Loading order details...</td></tr>';
    modal.style.display = 'flex';

    try {
        const delQuery = query(
            collection(db, 'deliveries'),
            where('order_id', '==', `PO-${orderNum}`)
        );
        const snapshot = await getDocs(delQuery);

        if (snapshot.empty) {
            tbody.innerHTML = '<tr><td colspan="6">Could not find this order.</td></tr>';
            return;
        }

        modal.dataset.deliveryDocIds = JSON.stringify(snapshot.docs.map(d => d.id));

        let grandTotal = 0;

        tbody.innerHTML = snapshot.docs.map(docSnap => {
            const delivery = docSnap.data();
            const unit = delivery.ingredient_unit ? ` ${delivery.ingredient_unit}` : '';
            const defaultQty = (delivery.shipped_quantity !== undefined)
                ? delivery.shipped_quantity
                : delivery.ordered_quantity;

            const shippedDisplay = (delivery.shipped_quantity !== undefined)
                ? `${delivery.shipped_quantity}${unit}`
                : '—';

            const unitPrice = delivery.unit_price || 0;
            const lineTotal = delivery.total_amount || 0;
            grandTotal += lineTotal;

            const priceDisplay = delivery.invoice_submitted
                ? `৳${unitPrice.toFixed(2)}`
                : `<span class="text-muted small-text">—</span>`;
            const totalDisplay = delivery.invoice_submitted
                ? `৳${lineTotal.toFixed(2)}`
                : `<span class="text-muted small-text">—</span>`;

            return `
            <tr data-delivery-doc-id="${docSnap.id}" 
                data-ingredient-id="${delivery.ingredient_id}"
                data-ordered-qty="${delivery.ordered_quantity || 0}">
                <td class="delivery-qty-cell">${delivery.ingredient_name}</td>
                <td class="delivery-ordered-cell">${delivery.ordered_quantity}${unit}</td>
                <td class="delivery-ordered-cell">${shippedDisplay}</td>
                <td class="delivery-input-cell">
                    <input type="number" class="form-control delivery-qty-input"
                           value="${defaultQty}" min="0">
                </td>
                <td class="delivery-ordered-cell">${priceDisplay}</td>
                <td class="delivery-ordered-cell">${totalDisplay}</td>
            </tr>`;
        }).join('');

        const grandTotalEl = document.getElementById('delivery-grand-total');
        if (grandTotalEl) grandTotalEl.textContent = `৳ ${grandTotal.toFixed(2)}`;

    } catch (err) {
        console.error('Failed to load order for delivery check-in:', err);
        tbody.innerHTML = '<tr><td colspan="6">Error loading order. See console.</td></tr>';
    }
}

function closeDeliveryModal() {
    document.getElementById('deliveryModal').style.display = 'none';
}

// Called by the Confirm & Update Stock button in the modal

async function confirmDeliveryCheckIn(orderNum) {
    const modal   = document.getElementById('deliveryModal');
    const docIds  = JSON.parse(modal.dataset.deliveryDocIds || '[]');
    const rows    = document.querySelectorAll('#delivery-modal-tbody tr[data-delivery-doc-id]');

    if (docIds.length === 0 || rows.length === 0) {
        alert('No order items found for this delivery.');
        return;
    }

    let anyPartial  = false;
    let anyReceived = false;

    try {
        for (const row of rows) {
            const deliveryDocId = row.dataset.deliveryDocId;
            const ingredientId  = row.dataset.ingredientId;
            const orderedQty    = parseFloat(row.dataset.orderedQty) || 0;
            const deliveredQty  = parseFloat(row.querySelector('.delivery-qty-input').value) || 0;

            if (deliveredQty > 0) {
                anyReceived = true;
                await receiveDelivery(ingredientId, deliveredQty);
            }

            const isPartial = deliveredQty < orderedQty;
            if (isPartial) anyPartial = true;

            await updateDoc(doc(db, 'deliveries', deliveryDocId), {
                delivered_quantity: deliveredQty,
                status: isPartial ? 'Partial Delivery' : 'Delivered',
                actual_date: serverTimestamp()
            });
        }

        alert(
            anyPartial
                ? `Partial shipment recorded for PO-${orderNum}. Stock updated for the items received.`
                : `Full order verified for PO-${orderNum}! Stock updated in Firebase.`
        );

        closeDeliveryModal();

    } catch (err) {
        console.error('Delivery check-in error:', err);
        alert('Failed to update delivery. Check console for details.');
    }
}
// ============================================================
//  3. FIREBASE WRITE — RECEIVE DELIVERY (stock increment)
// ============================================================

async function receiveDelivery(itemId, addedQty) {
    if (!addedQty || addedQty <= 0) {
        alert('Please enter a valid quantity.');
        return;
    }
    try {
        const itemRef = doc(db, 'inventory', itemId);
        await updateDoc(itemRef, {
            current_balance: increment(Number(addedQty))
        });
        console.log(`Stock updated: ${itemId} +${addedQty}`);
    } catch (error) {
        console.error('Error updating stock:', error);
        alert('Failed to update stock. Check console for details.');
    }
}

// ============================================================
//  4a. FIREBASE WRITE — SUBMIT PURCHASE ORDER
//     (also creates the matching 'deliveries' record so the
//      order is trackable through to check-in)
// ============================================================

async function submitPurchaseOrder() {
    const supplierSelect = document.getElementById('po-supplier');
    const supplierId     = supplierSelect.value;
    const supplierName   = supplierSelect.options[supplierSelect.selectedIndex]?.text || '';

    if (!supplierId) { alert('Please select a supplier.'); return; }
const entries = Object.entries(_selectedPOItems);
if (!entries.length) { alert('Please select at least one ingredient.'); return; }

const items = [];
for (const [id, item] of entries) {
    if (!item.qty || item.qty <= 0) {
        alert(`Please enter a valid quantity for ${item.name}.`);
        return;
    }
    items.push({ id, name: item.name, qty: item.qty, unit: item.unit || '' });
}

    try {
        const poRef = doc(collection(db, 'purchaseOrders'));
        const orderId = `PO-${poRef.id.slice(0, 6).toUpperCase()}`;

        await setDoc(poRef, {
            order_id: orderId, supplier_id: supplierId, supplier_name: supplierName,
            items, status: 'Pending', issue_date: serverTimestamp()
        });

        for (const item of items) {
            await addDoc(collection(db, 'deliveries'), {
                order_id: orderId, po_ref_id: poRef.id, supplier_id: supplierId, supplier_name: supplierName,
                ingredient_id: item.id, ingredient_name: item.name, ingredient_unit: item.unit,
                ordered_quantity: item.qty, status: 'Pending',
                scheduled_date: serverTimestamp(), invoice_submitted: false
            });
        }

        const itemsSummary = items.map(i => `${i.name}: ${i.qty}`).join(', ');
        await addDoc(collection(db, 'activities'), {
            text: `Purchase Order ${orderId} created for ${supplierName} (${items.length} item${items.length>1?'s':''})`,
            icon: 'fa-plus-circle', icon_color: 'primary', timestamp: serverTimestamp()
        });

        const supplierDoc = (window._suppliersCache || []).find(s => s.id === supplierId);
        let emailSent = false;
        if (supplierDoc?.email) {
            emailSent = await sendPOEmailToSupplier(supplierDoc.email, supplierName, orderId, itemsSummary);
        }

        alert(emailSent
            ? `Purchase Order ${orderId} submitted and emailed to ${supplierName}!`
            : `Purchase Order ${orderId} submitted! (Email notification failed — check with the supplier directly, or verify EmailJS setup.)`
        );

        Object.keys(_selectedPOItems).forEach(k => delete _selectedPOItems[k]);
        renderPOItemsTable(window._ingredientCache || []);

    } catch (err) {
        console.error('PO submission error:', err);
        alert('Failed to submit order.');
    }
}


// ============================================================
//  4b. ADD / EDIT INGREDIENT MODAL
// ============================================================

let ingredientModalMode = 'add';   // 'add' or 'edit'
let ingredientBeingEdited = null;  // doc id when editing

function handleIngredientSelection() {
    const select = document.getElementById('po-ingredient');
    if (select.value !== '__add_new__') return;
    select.value = '';               // reset dropdown until the ingredient is actually saved
    openIngredientModal('add');
}

function openIngredientModal(mode, item = null) {
    ingredientModalMode = mode;
    ingredientBeingEdited = item ? item.id : null;

    const titleEl     = document.getElementById('ingredientModalTitle');
    const nameInput   = document.getElementById('ingredient-name-input');
    const unitInput   = document.getElementById('ingredient-unit-input');
    const reorderInput= document.getElementById('ingredient-reorder-input');
    const balanceGroup= document.getElementById('ingredient-balance-group');
    const balanceInput= document.getElementById('ingredient-balance-input');
    const zeroNote    = document.getElementById('ingredient-zero-note');
    const saveBtnText = document.getElementById('ingredient-save-btn-text');

    if (mode === 'edit' && item) {
        titleEl.innerHTML = '<i class="fas fa-edit" style="color: var(--color-primary)"></i> Edit Ingredient';
        nameInput.value    = item.ingredient_name || '';
        unitInput.value    = item.stock_unit || 'kg';
        reorderInput.value = item.reorder_level ?? 10;
        balanceInput.value = item.current_balance ?? 0;
        balanceGroup.style.display = 'block';
        zeroNote.style.display     = 'none';
        saveBtnText.textContent    = 'Save Changes';
    } else {
        titleEl.innerHTML = '<i class="fas fa-carrot" style="color: var(--color-primary)"></i> Add New Ingredient';
        nameInput.value    = '';
        unitInput.value    = '';
        reorderInput.value = 10;
        balanceGroup.style.display = 'none';
        zeroNote.style.display     = 'block';
        saveBtnText.textContent    = 'Add Ingredient';
    }

    document.getElementById('ingredientModal').style.display = 'flex';
    nameInput.focus();
}

function closeIngredientModal() {
    document.getElementById('ingredientModal').style.display = 'none';
}

async function saveIngredientModal() {
    const name    = document.getElementById('ingredient-name-input').value.trim();
    const unit    = document.getElementById('ingredient-unit-input').value;
    const reorder = parseFloat(document.getElementById('ingredient-reorder-input').value);

    if (!name) {
        alert('Please enter an ingredient name.');
        return;
    }
    if (isNaN(reorder) || reorder < 0) {
        alert('Please enter a valid reorder threshold.');
        return;
    }

    try {
        if (ingredientModalMode === 'edit') {
            const balance = parseFloat(document.getElementById('ingredient-balance-input').value);
            if (isNaN(balance) || balance < 0) {
                alert('Please enter a valid current balance.');
                return;
            }
            await updateDoc(doc(db, 'inventory', ingredientBeingEdited), {
                ingredient_name: name,
                stock_unit:      unit,
                reorder_level:   reorder,
                current_balance: balance
            });
        } else {
            const newItemRef = await addDoc(collection(db, 'inventory'), {
                ingredient_name: name,
                stock_unit:      unit,
                reorder_level:   reorder,
                current_balance: 0
            });
            pendingIngredientSelection = newItemRef.id;

            await addDoc(collection(db, 'activities'), {
                text:       `New ingredient "${name}" added to inventory catalog`,
                icon:       'fa-plus-circle',
                icon_color: 'success',
                timestamp:  serverTimestamp()
            });
        }

        closeIngredientModal();

    } catch (err) {
        console.error('Failed to save ingredient:', err);
        alert('Failed to save ingredient. Check console for details.');
    }
}

async function deleteIngredient(itemId, itemName) {
    const confirmed = confirm(`Delete "${itemName}" from inventory? This cannot be undone.`);
    if (!confirmed) return;

    try {
        await deleteDoc(doc(db, 'inventory', itemId));
        await addDoc(collection(db, 'activities'), {
            text:       `Ingredient "${itemName}" removed from inventory catalog`,
            icon:       'fa-trash-alt',
            icon_color: 'danger',
            timestamp:  serverTimestamp()
        });
    } catch (err) {
        console.error('Failed to delete ingredient:', err);
        alert('Failed to delete ingredient. Check console for details.');
    }
}

function generateTempPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < 10; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}
// ============================================================
//  4c. FIREBASE AUTH — CREATE SUPPLIER ACCOUNT (secondary app)
// ============================================================

async function createSupplierAccount(name, phone, email, tempPassword) {
    let secondaryApp;
    try {
        secondaryApp = initializeApp(firebaseConfig, 'SecondaryForSupplierCreation_' + Date.now());
        const secondaryAuth = getAuth(secondaryApp);

        const userCred = await createUserWithEmailAndPassword(secondaryAuth, email, tempPassword);
        const newUid   = userCred.user.uid;

        await signOut(secondaryAuth);
        await deleteApp(secondaryApp);

        await addDoc(collection(db, 'suppliers'), {
            name:     name,
            phone:    phone,
            email:    email,
            auth_uid: newUid
        });

        await addDoc(collection(db, 'activities'), {
            text:       `New supplier "${name}" added with portal access`,
            icon:       'fa-handshake',
            icon_color: 'primary',
            timestamp:  serverTimestamp()
        });

        return true;

    } catch (err) {
        if (secondaryApp) {
            await deleteApp(secondaryApp).catch(() => {});
        }
        console.error('Failed to create supplier account:', err);

        if (err.code === 'auth/email-already-in-use') {
            alert('This email is already registered. Please use a different email.');
        } else if (err.code === 'auth/weak-password') {
            alert('Password must be at least 6 characters.');
        } else {
            alert('Failed to create supplier account: ' + err.message);
        }
        return false;
    }
}

// ============================================================
//  4d. FIREBASE AUTH — RESET SUPPLIER PASSWORD
// ============================================================

async function resetSupplierPassword(email) {
    try {
        const auth = getAuth();
        await sendPasswordResetEmail(auth, email);
        alert(`Password reset email sent to ${email}.`);
    } catch (err) {
        console.error('Failed to send reset email:', err);
        alert('Failed to send reset email: ' + err.message);
    }
}

// ============================================================
//  4f. DELETE SUPPLIER AUTH ACCOUNT — via external admin server
// ============================================================

const ADMIN_SERVER_URL = 'https://restaurant-ims-backend-bxh7.onrender.com';

async function deleteUserAsManager(targetUid) {
    try {
        const auth = getAuth();
        const managerToken = await auth.currentUser.getIdToken(true);

        const response = await fetch(`${ADMIN_SERVER_URL}/api/delete-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUid, managerToken })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Failed to delete Auth account.');
        }

        return true;

    } catch (err) {
        console.error('Failed to delete supplier Auth account:', err);
        alert('Warning: Firestore record removed, but the login account could not be deleted: ' + err.message);
        return false;
    }
}

// ============================================================
//  4g. CHECK FOR ORPHANED SUPPLIERS (deleted from Auth Console
//      but still present in Firestore) — runs when Suppliers
//      Directory or Purchase Orders tab is opened.
// ============================================================



let orphanCheckInProgress = false;

async function checkForOrphanedSuppliers(suppliers) {
    if (orphanCheckInProgress) return;
    orphanCheckInProgress = true;

    try {
        const auth = getAuth();
        if (!auth.currentUser) return;   // not logged in yet — skip silently

        const managerToken = await auth.currentUser.getIdToken(true);
        const orphaned = [];

        for (const supplier of suppliers) {
            if (!supplier.email || !supplier.auth_uid) continue;

            const response = await fetch(`${ADMIN_SERVER_URL}/api/check-user-exists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: supplier.email, managerToken })
            });

            if (!response.ok) continue;   // if the check itself fails, don't assume orphaned

            const result = await response.json();
            if (!result.exists) {
                orphaned.push(supplier);
            }
        }

        if (orphaned.length === 0) return;

        const names = orphaned.map(s => `• ${s.name} (${s.email})`).join('\n');
        const shouldCleanAll = confirm(
            `${orphaned.length} supplier account${orphaned.length > 1 ? 's have' : ' has'} been deleted from ` +
            `Firebase Authentication, but ${orphaned.length > 1 ? 'they are' : 'it is'} still listed:\n\n${names}\n\n` +
            `Remove ${orphaned.length > 1 ? 'these suppliers' : 'this supplier'} from the table now?`
        );

        if (shouldCleanAll) {
            for (const supplier of orphaned) {
                await deleteDoc(doc(db, 'suppliers', supplier.id));
                await addDoc(collection(db, 'activities'), {
                    text:       `Orphaned supplier "${supplier.name}" removed (Auth account was deleted externally)`,
                    icon:       'fa-broom',
                    icon_color: 'warning',
                    timestamp:  serverTimestamp()
                });
            }
        }

    } catch (err) {
        console.error('Orphaned supplier check failed:', err);
    } finally {
        orphanCheckInProgress = false;
    }
}
// ============================================================
// Extraaaaaaaaa
// ============================================================

function openSupplierModal() {
    supplierBeingEdited = null;

    document.getElementById('supplierModalTitle').innerHTML =
        '<i class="fas fa-handshake" style="color: var(--color-primary)"></i> Add New Supplier';
    document.getElementById('supplier-save-btn-text').textContent = 'Create Supplier Account';

    document.getElementById('supplier-name-input').value  = '';
    document.getElementById('supplier-phone-input').value = '+880';
    document.getElementById('supplier-email-input').value = '';

    document.getElementById('supplier-login-fields').style.display = 'block';
    document.getElementById('supplier-edit-note').style.display    = 'none';

    document.getElementById('supplierModal').style.display = 'flex';
}

function closeSupplierModal() {
    document.getElementById('supplierModal').style.display = 'none';

    // Restore the modal's original form HTML, since showCredentialsScreen()
    // overwrites it — otherwise the next "Add Supplier" click breaks.
    const box = document.getElementById('supplierModal').querySelector('.modal-box');
    box.innerHTML = `
        <h3 id="supplierModalTitle" style="margin-bottom: 1.5rem;">
            <i class="fas fa-handshake" style="color: var(--color-primary)"></i>
            Add New Supplier
        </h3>
        <div class="form-group">
            <label>Company / Supplier Name</label>
            <input id="supplier-name-input" type="text" class="form-control"
                   placeholder="e.g. Dhaka Fresh Produce Co.">
        </div>
        <div class="form-group">
            <label>Contact Phone</label>
            <input id="supplier-phone-input" type="text" class="form-control"
                   value="+880" maxlength="14"
                   oninput="enforcePhoneFormat(this)"
                   onkeydown="preventPrefixDeletion(event, this)">
        </div>
        <div id="supplier-login-fields">
            <div class="form-group">
                <label>Login Email (for supplier portal access)</label>
                <input id="supplier-email-input" type="email" class="form-control"
                       placeholder="e.g. orders@dhakafresh.com">
            </div>
        </div>
        <p id="supplier-edit-note" style="display:none; font-size: 0.8rem; color: #94a3b8; margin-bottom: 1rem;">
            Login email can't be changed here — use the key icon to send a password reset instead.
        </p>
        <div class="modal-footer">
            <button class="btn btn-outline" onclick="closeSupplierModal()">Cancel</button>
            <button class="btn btn-success" onclick="saveSupplierModal()">
                <i class="fas fa-check"></i> <span id="supplier-save-btn-text">Create Supplier Account</span>
            </button>
        </div>
    `;
}

async function saveSupplierModal() {
    const name  = document.getElementById('supplier-name-input').value.trim();
    const phone = document.getElementById('supplier-phone-input').value.trim();

    if (!name || phone.length < 14) {  // "+880" + 10 digits = 14 characters total
        alert('Please enter a valid name and complete 10-digit phone number.');
        return;
    }

    if (supplierBeingEdited) {
        // Edit mode — only name/phone are editable, email/password stay locked
        try {
            await updateDoc(doc(db, 'suppliers', supplierBeingEdited), { name, phone });
            supplierBeingEdited = null;
            closeSupplierModal();
        } catch (err) {
            console.error('Failed to update supplier:', err);
            alert('Failed to update supplier. Check console for details.');
        }
        return;
    }

    // Add mode — full account creation flow
    const email = document.getElementById('supplier-email-input').value.trim();

    if (!email) {
        alert('Please enter a login email.');
        return;
    }

    const password = generateTempPassword();   // ← generated, not typed

    const success = await createSupplierAccount(name, phone, email, password);
    if (success) {
        showCredentialsScreen(name, email, password, phone);
    }
}

function showCredentialsScreen(name, email, password, phone) {
    const loginLink = `${window.location.origin}/index.html`;
    const box = document.getElementById('supplierModal').querySelector('.modal-box');
    const credentialsText =
`Login Portal: ${loginLink}
Login Email: ${email}
Password: ${password}

Please use this link, email, and password to log in for the first time. For your security, we recommend resetting your password immediately after logging in.`;

    box.innerHTML = `
        <h3 style="margin-bottom: 1rem; color: var(--color-success);">
            <i class="fas fa-check-circle"></i> Supplier Account Created
        </h3>
        <p style="font-size: 0.9rem; color: #64748b; margin-bottom: 1.25rem;">
            Send these credentials to <strong>${name}</strong> — for security, this password will not be shown again after you close this window.
        </p>

        <div class="form-group">
            <textarea id="supplier-credentials-text" class="form-control" rows="7" readonly
                      style="font-family: monospace; resize: none;">${credentialsText}</textarea>
        </div>

        <div style="display:flex; gap:8px; margin-bottom: 1.25rem;">
            <button class="btn btn-outline" style="flex:1; justify-content:center;" onclick="copySupplierCredentials()">
                <i class="fas fa-copy"></i> Copy
            </button>
            <button class="btn btn-outline" style="flex:1; justify-content:center;"
                    onclick="emailSupplierCredentials('${email}', '${name}', '${password}')">
                <i class="fas fa-envelope"></i> Email
            </button>
            <button class="btn btn-outline" style="flex:1; justify-content:center;"
                    onclick="whatsappSupplierCredentials('${phone}', '${name}', '${email}', '${password}')">
                <i class="fab fa-whatsapp"></i> WhatsApp
            </button>
        </div>

        <div class="modal-footer">
            <button class="btn btn-success" onclick="closeSupplierModal()" style="width:100%; justify-content:center;">
                <i class="fas fa-check"></i> Done
            </button>
        </div>
    `;
}

function copySupplierCredentials() {
    const textArea = document.getElementById('supplier-credentials-text');
    textArea.select();
    navigator.clipboard.writeText(textArea.value)
        .then(() => alert('Credentials copied to clipboard!'))
        .catch(() => {
            document.execCommand('copy');
            alert('Credentials copied to clipboard!');
        });
}

function emailSupplierCredentials(email, name, password) {
    const loginLink = `${window.location.origin}/index.html`;
    const subject = encodeURIComponent('Your Restaurant IMS Supplier Portal Login');
    const body = encodeURIComponent(
`Hello ${name},

You've been added as a supplier on our Restaurant Inventory Management System.

Login Link: ${loginLink}
Login Email: ${email}
Temporary Password: ${password}

Please log in and change your password as soon as possible for security.

Thank you.`
    );

    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${subject}&body=${body}`;
    window.open(gmailUrl, '_blank');
}

function whatsappSupplierCredentials(phone, name, email, password) {
    const loginLink = `${window.location.origin}/index.html`;
    const cleanPhone = phone.replace(/\D/g, '');

    const message = encodeURIComponent(
`Hello ${name}, you've been added as a supplier on our Restaurant Inventory Management System.

Login Link: ${loginLink}
Login Email: ${email}
Temporary Password: ${password}

Please log in and change your password as soon as possible for security.`
    );
    window.open(`https://wa.me/${cleanPhone}?text=${message}`, '_blank');
}

//-------------------------------------------------------------
function sendPaymentEmailToSupplier(supplierEmail, supplierName, amount, orderId) {
    const templateParams = {
        to_email: supplierEmail,
        to_name: supplierName,
        order_id: orderId,
        amount: amount,
        payment_status: 'Paid'
    };

    emailjs.send('service_qyshhhs', 'template_jlw1fyv', templateParams)
        .then((response) => {
            console.log('🟢 Payment email sent via EmailJS!', response.status);
        }, (error) => {
            console.error('🔴 EmailJS failed:', error);
        });
}
//payment functions
//-------------------------------------------------------------
let paymentContext = null;

function openPaymentModal(orderId) {
    const items = (window._deliveriesGroupedCache || {})[orderId] || [];
    const total = items.reduce((sum, i) => sum + (i.total_amount || 0), 0);
    const supplierName = items[0]?.supplier_name || '';

    paymentContext = { orderId, amount: total, supplierName };

    document.getElementById('payment-order-label').textContent = `${orderId} — ${supplierName}`;
    document.getElementById('payment-amount-display').value = `৳ ${total.toFixed(2)}`;

    document.querySelectorAll('input[name="payment-method"]').forEach(r => r.checked = false);
    document.getElementById('payment-cash-note').style.display = 'none';

    document.getElementById('paymentModal').style.display = 'flex';
}
window.openPaymentModal = openPaymentModal;

function closePaymentModal() {
    document.getElementById('paymentModal').style.display = 'none';
    paymentContext = null;
}
window.closePaymentModal = closePaymentModal;

function togglePaymentMethodUI() {
    const method = document.querySelector('input[name="payment-method"]:checked').value;
    document.getElementById('payment-cash-note').style.display = method === 'cash' ? 'block' : 'none';
}
window.togglePaymentMethodUI = togglePaymentMethodUI;

async function makePayment() {
    const selected = document.querySelector('input[name="payment-method"]:checked');
    if (!selected) {
        alert('Please select a payment method (Online or Cash) before proceeding.');
        return;
    }
    if (selected.value === 'online') {
        await proceedToPayment();
    } else {
        await initiateCashPayment();
    }
}
window.makePayment = makePayment;

async function proceedToPayment() {
    if (!paymentContext || paymentContext.amount <= 0) {
        alert('Invalid payment amount.');
        return;
    }
    try {
        const auth = getAuth();
        const managerToken = await auth.currentUser.getIdToken(true);

        const response = await fetch(`${ADMIN_SERVER_URL}/api/init-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                orderId: paymentContext.orderId,
                amount: paymentContext.amount,
                supplierName: paymentContext.supplierName,
                managerToken
            })
        });

        const result = await response.json();
        if (!response.ok || !result.paymentUrl) {
            throw new Error(result.error || 'Failed to start payment.');
        }

        window.open(result.paymentUrl, '_blank');
        closePaymentModal();

    } catch (err) {
        console.error('Payment initiation failed:', err);
        alert('Failed to start payment: ' + err.message);
    }
}
window.proceedToPayment = proceedToPayment;

async function initiateCashPayment() {
    const items = (window._deliveriesGroupedCache || {})[paymentContext.orderId] || [];
    try {
        for (const item of items) {
            await updateDoc(doc(db, 'deliveries', item.id), {
                payment_status: 'Pending Cash Confirmation',
                payment_method: 'Cash'
            });
        }
        await addDoc(collection(db, 'activities'), {
            text: `Cash payment marked for ${paymentContext.orderId} — awaiting supplier confirmation`,
            icon: 'fa-hourglass-half', icon_color: 'warning', timestamp: serverTimestamp()
        });
        alert(`Cash payment recorded for ${paymentContext.orderId}. Waiting for the supplier to confirm receipt.`);
        closePaymentModal();
    } catch (err) {
        console.error('Failed to initiate cash payment:', err);
        alert('Failed to record cash payment.');
    }
}
// ============================================================
//  HELPER — Phone input formatting (+880 prefix, 10 digits max)
// ============================================================

function enforcePhoneFormat(input) {
    let digitsOnly = input.value.replace(/\D/g, '');   // strip everything non-numeric

    // Remove the country code digits (880) if user typed them again
    if (digitsOnly.startsWith('880')) {
        digitsOnly = digitsOnly.slice(3);
    }

    digitsOnly = digitsOnly.slice(0, 10);   // cap at 10 digits after +880

    input.value = '+880' + digitsOnly;
}

function preventPrefixDeletion(event, input) {
    const prefixLength = 4; // "+880"
    const cursorPos = input.selectionStart;

    // Block Backspace/Delete from eating into the +880 prefix
    if ((event.key === 'Backspace' && cursorPos <= prefixLength) ||
        (event.key === 'Delete' && cursorPos < prefixLength)) {
        event.preventDefault();
    }
}


// ============================================================
//  5. REAL-TIME LISTENERS — populate all tables dynamically
// ============================================================

// ── 5a. INVENTORY ──────────────────────────────────────────
function listenInventory() {
    console.log('📦 listenInventory() called');
    onSnapshot(
        collection(db, 'inventory'),
        (snapshot) => {
            console.log('📦 Inventory snapshot received. Doc count:', snapshot.docs.length);
            const items          = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            const lowStockItems  = items.filter(i => i.current_balance < i.reorder_level);

            const kpiTotal = document.getElementById('kpi-total-items');
            if (kpiTotal) kpiTotal.textContent = items.length;

            const kpiLow = document.getElementById('kpi-low-stock');
            if (kpiLow) kpiLow.textContent = lowStockItems.length;

            populateInventoryTable(items);
            populateLowStockAlerts(lowStockItems);
            populateIngredientDropdown(items);
        },
        (error) => {
            console.error('❌ Inventory listener error:', error);
        }
    );
}

function populateInventoryTable(items) {
    const tbody = document.getElementById('inventory-tbody');
    if (!tbody) return;

    // Cache items REGARDLESS of array length
    window._inventoryCache = items;

    if (items.length === 0) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="5">No inventory items found.</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => {
        const status     = getStockStatus(item.current_balance, item.reorder_level);
        const badgeClass = status === 'Normal' ? 'badge-success'
                          : status === 'Critical' ? 'badge-danger'
                          : 'badge-warning';
        const safeName = (item.ingredient_name || item.name || '').replace(/'/g, "\\'");
        return `
        <tr>
            <td>${item.ingredient_name || item.name || '—'}</td>
            <td>${item.current_balance}</td>
            <td>${item.stock_unit || item.unit || '—'}</td>
            <td><span class="badge ${badgeClass}">${status}</span></td>
            <td style="display:flex; gap:6px;">
                <button class="btn btn-sm btn-outline" onclick="openIngredientEditById('${item.id}')">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-sm btn-outline" style="color:var(--color-danger); border-color:#fecaca;"
                        onclick="deleteIngredient('${item.id}', '${safeName}')">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </td>
        </tr>`;
    }).join('');
}

function openIngredientEditById(itemId) {
    const item = (window._inventoryCache || []).find(i => i.id === itemId);
    if (!item) return;
    openIngredientModal('edit', item);
}

function populateLowStockAlerts(lowStockItems) {
    const tbody = document.getElementById('low-stock-tbody');
    if (!tbody) return;

    if (lowStockItems.length === 0) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="3">✅ All stock levels are normal.</td></tr>';
        return;
    }

    tbody.innerHTML = lowStockItems.map(item => {
        const color = item.current_balance <= 2 ? 'var(--color-danger)' : 'var(--color-warning)';
        return `
        <tr>
            <td>${item.ingredient_name || item.name || '—'}</td>
            <td><span style="color:${color}; font-weight:700;">${item.current_balance} ${item.stock_unit || ''}</span></td>
            <td>${item.reorder_level} ${item.stock_unit || ''}</td>
        </tr>`;
    }).join('');
}

function populateIngredientDropdown(items) {
    window._ingredientCache = items;   // cache for search filtering
    renderPOItemsTable(items);
}

// ── PO Selection State (persists across search/filter) ──
const _selectedPOItems = {};  // { ingredientId: { name, qty, unit } }

function renderPOItemsTable(items) {
    const container = document.getElementById('po-items-table-body');
    if (!container) return;

    const addNewRow = `
        <tr class="add-new-ingredient-row" onclick="openIngredientModal('add')">
            <td colspan="4"><i class="fas fa-plus"></i> Add New Ingredient...</td>
        </tr>`;

    // Replace itemRows mapping inside renderPOItemsTable (around Line 715)
const itemRows = items.map(item => {
    const selected = !!_selectedPOItems[item.id];
    const savedQty = _selectedPOItems[item.id]?.qty || '';
    return `
    <tr data-id="${item.id}"
        data-name="${(item.ingredient_name||'').replace(/"/g,'&quot;')}"
        data-unit="${item.stock_unit || ''}"
        onclick="onRowClick(event, this)"
        style="cursor: pointer;">
        <td><input type="checkbox" class="po-item-checkbox"
                   ${selected ? 'checked' : ''}
                   onchange="onPOCheckboxChange(this)"></td>
        <td>${item.ingredient_name || '—'}</td>
        <td>${item.stock_unit || '—'}</td>
        <td><input type="number" class="form-control po-item-qty"
                   min="0" value="${savedQty}"
                   oninput="onPOQtyChange(this)"
                   onclick="event.stopPropagation();"
                   style="width:100px;"></td>
    </tr>`;
}).join('');

    container.innerHTML = addNewRow + itemRows;
    renderSelectedChips();
}

function onPOCheckboxChange(checkbox) {
    const row  = checkbox.closest('tr');
    const id   = row.dataset.id;
    const name = row.dataset.name;
    const unit = row.dataset.unit;
    const qty  = parseFloat(row.querySelector('.po-item-qty').value) || 0;

    if (checkbox.checked) {
        _selectedPOItems[id] = { name, qty, unit };
    } else {
        delete _selectedPOItems[id];
    }
    renderSelectedChips();
}

function onRowClick(event, row) {
    // Prevent double toggling if user directly clicks the checkbox itself
    if (event.target.type === 'checkbox' || event.target.tagName === 'INPUT') return;

    const checkbox = row.querySelector('.po-item-checkbox');
    checkbox.checked = !checkbox.checked;
    onPOCheckboxChange(checkbox);
}

function onPOQtyChange(input) {
    const row = input.closest('tr');
    const id = row.dataset.id;
    const name = row.dataset.name;
    const unit = row.dataset.unit;
    const checkbox = row.querySelector('.po-item-checkbox');
    const val = parseFloat(input.value);

    if (!isNaN(val) && val > 0) {
        // Auto-check the checkbox and update state when quantity is entered
        checkbox.checked = true;
        _selectedPOItems[id] = { name, qty: val, unit };
    } else {
        // Uncheck if quantity is cleared or zero
        checkbox.checked = false;
        delete _selectedPOItems[id];
    }
    renderSelectedChips();
}
window.onRowClick = onRowClick;

function renderSelectedChips() {
    const container = document.getElementById('po-selected-chips');
    if (!container) return;
    const keys = Object.keys(_selectedPOItems);
    if (!keys.length) {
        container.innerHTML = '<span class="chips-empty">No items selected yet.</span>';
        return;
    }
    container.innerHTML = keys.map(id => {
        const item = _selectedPOItems[id];
        return `<span class="po-chip">
            ${item.name}
            <strong>${item.qty || '?'} ${item.unit}</strong>
            <button onclick="removePOChip('${id}')" title="Remove">×</button>
        </span>`;
    }).join('');
}

function removePOChip(id) {
    delete _selectedPOItems[id];
    // uncheck the row if currently visible
    const row = document.querySelector(`#po-items-table-body tr[data-id="${id}"]`);
    if (row) {
        const cb = row.querySelector('.po-item-checkbox');
        const qi = row.querySelector('.po-item-qty');
        if (cb) cb.checked = false;
        if (qi) qi.value = '';
    }
    renderSelectedChips();
}

function filterPOIngredients() {
    const term     = document.getElementById('po-ingredient-search').value.toLowerCase().trim();
    const allItems = window._ingredientCache || [];
    const filtered = term
        ? allItems.filter(i => (i.ingredient_name || '').toLowerCase().includes(term))
        : allItems;
    renderPOItemsTable(filtered);
}
window.filterPOIngredients = filterPOIngredients;
window.onPOCheckboxChange  = onPOCheckboxChange;
window.onPOQtyChange       = onPOQtyChange;
window.removePOChip        = removePOChip;



// ── 5b. SUPPLIERS ──────────────────────────────────────────
function listenSuppliers() {
    onSnapshot(collection(db, 'suppliers'), (snapshot) => {
        const suppliers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        window._suppliersCache = suppliers;   // ← add this line (may already exist — check first)
        populateSuppliersTable(suppliers);
        populateSupplierDropdown(suppliers);
    });
}

function populateSuppliersTable(suppliers) {
    const tbody = document.getElementById('suppliers-tbody');
    if (!tbody) return;

    if (suppliers.length === 0) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="4">No suppliers found.</td></tr>';
        return;
    }

    window._suppliersCache = suppliers;

    tbody.innerHTML = suppliers.map(s => {
        const safeName = (s.name || '').replace(/'/g, "\\'");
        return `
        <tr>
            <td><strong>${s.name || '—'}</strong></td>
            <td>${s.phone || '—'}</td>
            <td>${s.email || '—'}</td>
            <td style="display:flex; gap:6px;">
                <button class="btn btn-sm btn-outline" onclick="openSupplierEditById('${s.id}')">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-sm btn-outline" style="color:var(--color-danger); border-color:#fecaca;"
        onclick="deleteSupplier('${s.id}', '${safeName}', '${s.auth_uid || ''}')">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </td>
        </tr>`;
    }).join('');
}
 //-------------------------------------------------
 //supplier delete and edit from UI
 //----------------------------------------------------
function openSupplierEditById(supplierId) {
    const supplier = (window._suppliersCache || []).find(s => s.id === supplierId);
    if (!supplier) return;

    supplierBeingEdited = supplierId;

    document.getElementById('supplierModalTitle').innerHTML =
        '<i class="fas fa-edit" style="color: var(--color-primary)"></i> Edit Supplier';
    document.getElementById('supplier-save-btn-text').textContent = 'Update Supplier';

    document.getElementById('supplier-name-input').value  = supplier.name || '';
    document.getElementById('supplier-phone-input').value = supplier.phone || '+880';

    // Hide login fields entirely in edit mode — not just disabled, fully removed from view
    document.getElementById('supplier-login-fields').style.display = 'none';
    document.getElementById('supplier-edit-note').style.display    = 'block';

    document.getElementById('supplierModal').style.display = 'flex';
}

async function deleteSupplier(supplierId, supplierName, authUid) {
    const confirmed = confirm(`Permanently delete "${supplierName}"? This removes their directory entry and login access.`);
    if (!confirmed) return;

    try {
        await deleteDoc(doc(db, 'suppliers', supplierId));

        if (authUid) {
            await deleteUserAsManager(authUid);
        }

        await addDoc(collection(db, 'activities'), {
            text:       `Supplier "${supplierName}" removed from directory`,
            icon:       'fa-trash-alt',
            icon_color: 'danger',
            timestamp:  serverTimestamp()
        });
    } catch (err) {
        console.error('Failed to delete supplier:', err);
        alert('Failed to delete supplier. Check console for details.');
    }
}
//-------------------------------------------------

function populateSupplierDropdown(suppliers) {
    const select = document.getElementById('po-supplier');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="" disabled selected>Choose a registered supplier enterprise...</option>';
    suppliers.forEach(s => {
        const opt = document.createElement('option');
        opt.value       = s.id;
        opt.textContent = s.name || s.id;
        select.appendChild(opt);
    });
    if (current) select.value = current;
}

// ── 5c. PURCHASE ORDERS (LIVE UPDATING) ────────────────────
// ── 5c. PURCHASE ORDERS (LIVE UPDATING) ────────────────────
function listenPurchaseOrders() {
    const q = query(collection(db, 'purchaseOrders'), orderBy('issue_date', 'desc'));

    onSnapshot(q, (poSnapshot) => {
        const orders = poSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

        // Real-time deliveries check to filter out fulfilled orders
        onSnapshot(collection(db, 'deliveries'), (delSnapshot) => {
            const completedPoIds = new Set();

            delSnapshot.docs.forEach(doc => {
                const data = doc.data();
                const poId = data.order_id || data.po_number;
                const status = String(data.status || data.action || '').toLowerCase();

                if (status.includes('delivered') && !status.includes('partially')) {
                    completedPoIds.add(poId);
                }
            });

            // Pending POs are those marked 'Pending' and not completed in deliveries
            const activePendingOrders = orders.filter(o => 
                o.status === 'Pending' && !completedPoIds.has(o.order_id)
            );

            // Live update KPI
            const kpiPO = document.getElementById('kpi-pending-po');
            if (kpiPO) kpiPO.textContent = activePendingOrders.length;
        });
    });
}

function populateRecentPOsTable(orders) {
    const tbody = document.getElementById('recent-po-tbody');
    if (!tbody) return;

    if (orders.length === 0) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="5">No purchase orders yet.</td></tr>';
        return;
    }

    tbody.innerHTML = orders.map(o => {
        const badgeClass = o.status === 'Pending'  ? 'badge-warning'
                          : o.status === 'Approved' ? 'badge-success'
                          : o.status === 'Received' ? 'badge-success'
                          : 'badge-warning';
        const date = o.issue_date?.toDate
                   ? o.issue_date.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                   : o.issue_date || '—';
        const amount = o.total_amount ? `$${Number(o.total_amount).toFixed(2)}` : '—';
        const poLabel = o.order_id || o.id.slice(0, 6).toUpperCase();
        return `
        <tr>
            <td><strong>${poLabel}</strong></td>
            <td>${o.supplier_name || '—'}</td>
            <td>${date}</td>
            <td><span class="badge ${badgeClass}">${o.status || '—'}</span></td>
            <td>${amount}</td>
        </tr>`;
    }).join('');
}

// ── 5d. DELIVERIES ─────────────────────────────────────────
function listenDeliveries() {
    onSnapshot(collection(db, 'deliveries'), (snapshot) => {
        const deliveries = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

        const upcoming = deliveries.filter(d => d.status === 'Pending' || d.status === 'Partial Delivery').length;
        const kpiDel   = document.getElementById('kpi-upcoming-deliveries');
        if (kpiDel) kpiDel.textContent = upcoming;

        populateDeliveriesTable(deliveries);
    });
}

// Replace the existing populateDeliveriesTable function in manager.js
function populateDeliveriesTable(deliveries) {
    const tbody = document.getElementById('deliveries-tbody');
    if (!tbody) return;

    if (deliveries.length === 0) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="3">No deliveries found.</td></tr>';
        return;
    }

    // Sort newest first BEFORE grouping, so new orders land at the top
    const sorted = [...deliveries].sort((a, b) =>
        (b.scheduled_date?.seconds || 0) - (a.scheduled_date?.seconds || 0)
    );

    const grouped = {};
    sorted.forEach(d => {
        const key = d.order_id || d.id;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(d);
    });

    window._deliveriesGroupedCache = grouped;

    tbody.innerHTML = Object.entries(grouped).map(([orderId, items]) => {
        const allDelivered = items.every(i => i.status === 'Delivered' || i.status === 'Partial Delivery');
        const anyPartial   = items.some(i => i.status === 'Partial Delivery');
        const anyPending   = items.some(i => i.status === 'Pending');
        const anyShipped   = items.some(i => i.status === 'Shipped');

        const anyPaidCheck   = items.some(i => i.payment_status === 'Paid');
        const anyPendingCash = items.some(i => i.payment_status === 'Pending Cash Confirmation');

        let badgeClass = 'badge-warning', statusLabel = 'Pending', rowClass = 'row-status-pending';
        
        if (allDelivered && anyPaidCheck) {
            const method = items.find(i => i.payment_status === 'Paid')?.payment_method;
            const prefix = anyPartial ? 'Partially Delivered' : 'Delivered';
            badgeClass = 'badge-success';
            statusLabel = `${prefix} & Paid (${method === 'Cash' ? 'Cash' : 'Online'})`;
            rowClass = 'row-status-delivered';
        } else if (allDelivered && anyPendingCash) {
            badgeClass = 'badge-warning'; 
            statusLabel = anyPartial ? 'Partially Delivered (Awaiting Cash Confirmation)' : 'Awaiting Cash Confirmation'; 
            rowClass = 'row-status-shipped';
        } else if (allDelivered) {
            badgeClass = 'badge-success'; 
            statusLabel = anyPartial ? 'Partially Delivered' : 'Delivered'; 
            rowClass = 'row-status-delivered';
        } else if (anyShipped && !anyPending) {
            badgeClass = 'badge-warning'; 
            statusLabel = 'Shipped'; 
            rowClass = 'row-status-shipped';
        }

        const dateStr = items[0].scheduled_date?.toDate
                      ? items[0].scheduled_date.toDate().toLocaleDateString()
                      : '—';

        const itemsList = items.map(i =>
            `${i.ingredient_name}: ${i.ordered_quantity}${i.ingredient_unit ? ' ' + i.ingredient_unit : ''}`
        ).join(', ');

        const anyInvoiced   = items.some(i => i.invoice_submitted);
        const totalAmount   = items.reduce((sum, i) => sum + (i.total_amount || 0), 0);
        const amountLine    = anyInvoiced
            ? `<br><span class="text-muted small-text">Invoice: ৳${totalAmount.toFixed(2)}</span>`
            : '';

        const shortNum = orderId.replace('PO-', '');
        const anyPaid = items.some(i => i.payment_status === 'Paid');
        let actionBtn;

        if (allDelivered && anyPaid) {
            actionBtn = `<button class="btn btn-sm btn-outline" disabled><i class="fas fa-check-circle"></i> Paid</button>`;
        } else if (allDelivered && anyPendingCash) {
            actionBtn = `<button class="btn btn-sm btn-outline" disabled><i class="fas fa-hourglass-half"></i> Awaiting Cash Confirmation</button>`;
        } else if (allDelivered) {
            actionBtn = `<button class="btn btn-sm btn-success" onclick="openPaymentModal('${orderId}')">
                            <i class="fas fa-money-bill-wave"></i> Pay Supplier
                         </button>`;
        } else if (anyShipped) {
            actionBtn = `<button id="btn-${shortNum}" class="btn btn-sm btn-primary" onclick="receiveLogistics('${shortNum}')">
                            <i class="fas fa-sync-alt"></i> Update Status
                          </button>`;
        } else {
            actionBtn = `<button id="btn-${shortNum}" class="btn btn-sm btn-outline" onclick="viewOrderedItems('${orderId}')">
                            <i class="fas fa-eye"></i> Ordered
                          </button>`;
        }

        return `
        <tr class="${rowClass}">
            <td>
                <strong>${orderId}</strong>
                <br><span class="supplier-name-tag">${items[0]?.supplier_name || '—'}</span>
                <br><span class="text-muted small-text">${itemsList}</span>
                ${amountLine}
            </td>
            <td>
                <span id="badge-${shortNum}" class="badge ${badgeClass}">${dateStr} ${statusLabel}</span>
            </td>
            <td>${actionBtn}</td>
        </tr>`;
    }).join('');
}

//------------------------------------------------------
function viewOrderedItems(orderId) {
    const items = (window._deliveriesGroupedCache || {})[orderId] || [];
    if (items.length === 0) return;

    const modal   = document.getElementById('deliveryModal');
    const tbody   = document.getElementById('delivery-modal-tbody');
    const titleEl = document.getElementById('deliveryModalTitle');
    const footer  = modal.querySelector('.modal-footer');

    titleEl.textContent = `Order Details (${orderId})`;
    modal.querySelector('.modal-note').textContent = 'This order has not been shipped by the supplier yet — nothing to verify.';

    tbody.innerHTML = items.map(item => {
        const unit = item.ingredient_unit ? ` ${item.ingredient_unit}` : '';
        return `
        <tr>
            <td class="delivery-qty-cell">${item.ingredient_name}</td>
            <td class="delivery-ordered-cell">${item.ordered_quantity}${unit}</td>
            <td class="delivery-ordered-cell">—</td>
            <td class="delivery-input-cell">—</td>
        </tr>`;
    }).join('');

    // Swap footer to just a Close button for this read-only view
    footer.innerHTML = `<button class="btn btn-outline" onclick="closeDeliveryModal()">Close</button>`;

    modal.style.display = 'flex';
}
window.viewOrderedItems = viewOrderedItems;

// ── 5e. RECENT ACTIVITIES ──────────────────────────────────
function listenActivities() {
    // Calculate timestamp for 7 days ago
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const q = query(
        collection(db, 'activities'),
        where('timestamp', '>=', sevenDaysAgo),
        orderBy('timestamp', 'desc')
    );

    onSnapshot(q, (snapshot) => {
        const activities = snapshot.docs.map(d => d.data());
        populateActivityFeed(activities);
    });
}

function populateActivityFeed(activities) {
    const feed = document.getElementById('activity-feed');
    if (!feed) return;

    if (activities.length === 0) {
        feed.innerHTML = '<li style="color:#94a3b8; font-style:italic;">No recent activities.</li>';
        return;
    }

    const iconColorMap = { primary: 'var(--color-primary)', success: 'var(--color-success)', danger: 'var(--color-danger)', warning: 'var(--color-warning)' };

    feed.innerHTML = activities.map(a => {
        const color   = iconColorMap[a.icon_color] || 'var(--color-primary)';
        const icon    = a.icon || 'fa-circle';
        const timeStr = a.timestamp?.toDate
                       ? a.timestamp.toDate().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                       : '';
        return `
        <li>
            <i class="fas ${icon}" style="color:${color}; margin-top:3px;"></i>
            <div>
                <strong>${a.text || '—'}</strong>
                <span class="activity-time">${timeStr}</span>
            </div>
        </li>`;
    }).join('');
}

// ============================================================
//  6. HELPER — Stock Status
// ============================================================

function getStockStatus(current, reorderLevel) {
    if (current <= 2)           return 'Critical';
    if (current < reorderLevel) return 'Low Stock';
    return 'Normal';
}

// ============================================================
//  7. EXPOSE TO WINDOW (needed for HTML onclick attributes)
// ============================================================

window.receiveLogistics       = receiveLogistics;
window.closeDeliveryModal     = closeDeliveryModal;
window.confirmDeliveryCheckIn = confirmDeliveryCheckIn;
window.receiveDelivery        = receiveDelivery;
window.submitPurchaseOrder    = submitPurchaseOrder;
window.handleIngredientSelection = handleIngredientSelection;
window.openIngredientModal       = openIngredientModal;
window.closeIngredientModal      = closeIngredientModal;
window.saveIngredientModal       = saveIngredientModal;
window.deleteIngredient          = deleteIngredient;
window.openIngredientEditById    = openIngredientEditById;
window.openSupplierModal  = openSupplierModal;
window.closeSupplierModal = closeSupplierModal;
window.saveSupplierModal  = saveSupplierModal;
window.enforcePhoneFormat     = enforcePhoneFormat;
window.preventPrefixDeletion  = preventPrefixDeletion;
window.openSupplierEditById = openSupplierEditById;
window.deleteSupplier       = deleteSupplier;
window.resetSupplierPassword = resetSupplierPassword;
window.copySupplierCredentials     = copySupplierCredentials;
window.emailSupplierCredentials    = emailSupplierCredentials;
window.whatsappSupplierCredentials = whatsappSupplierCredentials;
window.deleteUserAsManager = deleteUserAsManager;
window.checkForOrphanedSuppliers = checkForOrphanedSuppliers;
// ============================================================
//  8. INIT — Start all real-time listeners
// ============================================================

function initDashboard() {
    console.log('🟢 initDashboard() running. db is:', db);
    if (!db) {
        console.log('🔴 db is falsy — listeners will NOT run.');
        return;
    }

    // CHECK AUTHENTICATION AND SWITCH TAB ON PAYMENT REDIRECT
    const auth = getAuth();
    onAuthStateChanged(auth, (user) => {
        if (!user) {
            // If user lost session/token, send to login
            window.location.href = 'index.html';
            return;
        }

        // Switch to delivery logs tab if returning from payment
        if (window.location.hash === '#delivery-logs') {
            const deliveryTabBtn = document.querySelector('[data-section="delivery-logs"]') 
                                || document.getElementById('delivery-logs-tab')
                                || document.querySelector('a[href="#delivery-logs"]');
            if (deliveryTabBtn) {
                deliveryTabBtn.click();
            }
        }
    });

    console.log('🟢 Starting listeners...');
    listenInventory();
    listenSuppliers();
    listenPurchaseOrders();
    listenDeliveries();
    listenActivities();
    console.log('🟢 All listen...() calls completed.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDashboard);
} else {
    // DOMContentLoaded already fired before this module ran — call directly
    initDashboard();
}

// Automatically switch to Delivery Logs tab when redirected back from SSLCommerz payment
window.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash === '#delivery-logs') {
        // Triggers the tab click for Delivery Logs
        const deliveryTabBtn = document.querySelector('[data-section="delivery-logs"]') 
                            || document.getElementById('delivery-logs-tab')
                            || document.querySelector('a[href="#delivery-logs"]');
        if (deliveryTabBtn) {
            deliveryTabBtn.click();
        }
    }
});