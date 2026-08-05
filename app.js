// Application Logic for Parking System with Card Barcode Scanner Support

let pendingSavePayload = null;

document.addEventListener('DOMContentLoaded', () => {
  startLiveClock();
  setupKeyboardShortcuts();
  setupEnterKeyNavigation();

  // Clear login inputs
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  if (usernameInput) usernameInput.value = '';
  if (passwordInput) passwordInput.value = '';

  // Check current browser tab session
  const storedSession = sessionStorage.getItem('veloReg_session');
  if (storedSession) {
    try {
      const session = JSON.parse(storedSession);
      showDashboard(session);
      return;
    } catch (e) {
      console.error('Session error:', e);
    }
  }

  // If no active session, show Login screen
  const loginContainer = document.getElementById('login-container');
  const dashboardContainer = document.getElementById('dashboard-container');
  const footer = document.getElementById('main-footer');

  if (loginContainer && dashboardContainer) {
    dashboardContainer.classList.add('hidden');
    dashboardContainer.classList.remove('flex');
    loginContainer.classList.remove('hidden');
    if (footer) footer.classList.remove('hidden');
  }
});

// Sequential Enter Key Navigation between Form Fields
function setupEnterKeyNavigation() {
  const form = document.getElementById('parking-entry-form');
  if (!form) return;

  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Prevent default form submission on intermediate fields
      e.preventDefault();

      const focusableElements = [
        'p-token-no',
        'p-veh-type',
        'p-veh-type-other',
        'p-veh-s1',
        'p-veh-s2',
        'p-veh-s3',
        'p-veh-s4',
        'p-cust-name',
        'p-mobile-no',
        'p-rate'
      ];

      const currentId = e.target.id;
      const currentIndex = focusableElements.indexOf(currentId);

      // If on the final Rate field, submit form / open barcode scan modal
      if (currentId === 'p-rate') {
        document.getElementById('parking-entry-form').requestSubmit();
        return;
      }

      // Jump to next visible form field
      if (currentIndex !== -1) {
        for (let i = currentIndex + 1; i < focusableElements.length; i++) {
          const nextEl = document.getElementById(focusableElements[i]);
          if (nextEl && !nextEl.closest('.hidden')) {
            nextEl.focus();
            if (typeof nextEl.select === 'function') nextEl.select();
            break;
          }
        }
      }
    }
  });
}

// Real-Time Clock & Date Ticker
function startLiveClock() {
  const clockEl = document.getElementById('live-clock');
  const dateEl = document.getElementById('live-date');

  function updateTime() {
    const now = new Date();
    
    if (clockEl) {
      clockEl.textContent = now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    }

    if (dateEl) {
      const day = String(now.getDate()).padStart(2, '0');
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = monthNames[now.getMonth()];
      const year = now.getFullYear();
      dateEl.textContent = `${day}-${month}-${year}`;
    }
  }

  updateTime();
  setInterval(updateTime, 1000);
}

// Global Keyboard Shortcuts (F2 = Save, F5 = Refresh, Esc = Clear, F12 = Exit Checkout)
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const dashboard = document.getElementById('dashboard-container');
    const modal = document.getElementById('barcode-modal');
    const exitScanModal = document.getElementById('exit-scan-modal');
    const exitCheckoutModal = document.getElementById('exit-checkout-modal');
    const enquiryModal = document.getElementById('enquiry-modal');
    const historyModal = document.getElementById('history-modal');

    if (!dashboard || dashboard.classList.contains('hidden')) return;

    // Handle Escape for active modals
    if (e.key === 'Escape') {
      if (modal && !modal.classList.contains('hidden')) {
        closeBarcodeModal();
        return;
      }
      if (exitScanModal && !exitScanModal.classList.contains('hidden')) {
        closeExitScanModal();
        return;
      }
      if (exitCheckoutModal && !exitCheckoutModal.classList.contains('hidden')) {
        closeExitCheckoutModal();
        return;
      }
      if (enquiryModal && !enquiryModal.classList.contains('hidden')) {
        closeEnquiryModal();
        return;
      }
      if (historyModal && !historyModal.classList.contains('hidden')) {
        closeExitHistoryModal();
        return;
      }
      e.preventDefault();
      resetParkingForm();
      return;
    }

    if (e.key === 'F2') {
      e.preventDefault();
      document.getElementById('parking-entry-form').requestSubmit();
    } else if (e.key === 'F5') {
      e.preventDefault();
      triggerViewAction();
    } else if (e.key === 'F12') {
      e.preventDefault();
      openExitScanModal();
    }
  });
}

// ─────────────────────────────────────────────────────────────────
// Global Barcode Scanner Auto-Fill
// USB barcode scanners fire characters very rapidly (< 50ms apart)
// followed by an Enter key. We intercept every keypress, buffer the
// characters, and on Enter — regardless of which field is focused —
// extract the numeric token, clear stray chars from any focused input,
// and fill the Token No field automatically.
// ─────────────────────────────────────────────────────────────────
(function setupBarcodeScannerAutoFill() {
  let scanBuffer = '';
  let lastKeyTime = 0;
  let bufferTimestamp = 0;
  const SCANNER_SPEED_MS = 50; // scanners fire each char in < 50ms

  document.addEventListener('keypress', (e) => {
    const dashboard = document.getElementById('dashboard-container');
    if (!dashboard || dashboard.classList.contains('hidden')) return;

    // If any modal is open, let the modal handle its own input — skip
    const openModals = ['barcode-modal', 'exit-scan-modal', 'exit-checkout-modal', 'history-modal', 'enquiry-modal'];
    if (openModals.some(id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    })) return;

    const now = Date.now();
    const gap = now - lastKeyTime;
    lastKeyTime = now;

    if (e.key === 'Enter') {
      const raw = scanBuffer.trim();
      const scanDuration = now - bufferTimestamp;
      scanBuffer = '';

      // Only treat as scanner if: buffer has content, was fast (scanner speed)
      // and the whole sequence came in under 500ms
      if (raw.length < 2 || scanDuration > 500) return;

      // Extract digits from barcode (e.g. "CARD-512" → "512", "0512" → "512")
      const digits = raw.replace(/\D/g, '');
      if (!digits) return;

      const tokenNo = parseInt(digits, 10);
      if (isNaN(tokenNo)) return;

      // If the scan accidentally landed in a focused input field, clear those chars
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        // Remove exactly the characters the scanner typed into this field
        const currentVal = active.value || '';
        // Strip the scanned characters from the end of the field value
        if (currentVal.toLowerCase().endsWith(raw.toLowerCase())) {
          active.value = currentVal.slice(0, currentVal.length - raw.length);
        } else {
          // As fallback, clear only if field value IS the barcode scan
          const fieldDigits = currentVal.replace(/\D/g, '');
          if (fieldDigits === digits) active.value = '';
        }
        active.dispatchEvent(new Event('input'));
      }

      // ✅ Fill Token No field
      const tokenInput = document.getElementById('p-token-no');
      if (tokenInput) {
        tokenInput.value = tokenNo;
        tokenInput.dispatchEvent(new Event('input'));

        // Flash green to confirm scan
        tokenInput.style.outline = '3px solid #10b981';
        tokenInput.style.backgroundColor = '#f0fdf4';
        tokenInput.style.transition = 'all 0.3s';
        setTimeout(() => {
          tokenInput.style.outline = '';
          tokenInput.style.backgroundColor = '';
        }, 1400);
      }

      showToast(`🔍 Card scanned — Token #${tokenNo} filled!`, 'success');
      e.preventDefault();
      return;
    }

    // Accumulate printable characters into the scan buffer
    if (e.key.length === 1) {
      if (gap > SCANNER_SPEED_MS * 4) {
        // Gap too large — this is manual typing, reset buffer
        scanBuffer = '';
        bufferTimestamp = now;
      }
      scanBuffer += e.key;
      if (scanBuffer.length === 1) bufferTimestamp = now;
    }
  });
})();



// Auto-Tab & Format Vehicle Number Formula Inputs
function autoTabVehicleInput(currentInput, nextInputId, targetLength) {
  currentInput.value = currentInput.value.toUpperCase();
  if (currentInput.value.length >= targetLength && nextInputId) {
    const nextInput = document.getElementById(nextInputId);
    if (nextInput) nextInput.focus();
  }
}

// Assemble full vehicle number formula string (e.g. TN 67 AD 2007)
function getFormattedVehicleNumber() {
  const s1 = (document.getElementById('p-veh-s1')?.value || '').trim().toUpperCase();
  const s2 = (document.getElementById('p-veh-s2')?.value || '').trim();
  const s3 = (document.getElementById('p-veh-s3')?.value || '').trim().toUpperCase();
  const s4 = (document.getElementById('p-veh-s4')?.value || '').trim();

  const parts = [s1, s2, s3, s4].filter(p => p.length > 0);
  return parts.join(' ');
}

// Trigger Barcode Scanning Modal after clicking Save - F2
function triggerSaveBarcodeModal(event) {
  event.preventDefault();

  const tokenInput = document.getElementById('p-token-no');
  const tokenNo = parseInt(tokenInput.value) || parseInt(tokenInput.getAttribute('data-auto-token')) || 500;

  let vehType = document.getElementById('p-veh-type').value;
  if (vehType === 'OTHER') {
    const otherVal = (document.getElementById('p-veh-type-other')?.value || '').trim().toUpperCase();
    vehType = otherVal || 'OTHER';
  }
  const vehNo = getFormattedVehicleNumber();
  const custName = document.getElementById('p-cust-name').value.trim();
  const mobileNo = document.getElementById('p-mobile-no').value.trim();
  const rate = parseFloat(document.getElementById('p-rate').value) || 15;
  const paymentMode = document.querySelector('input[name="payment_mode"]:checked')?.value || 'CASH';

  if (!vehNo) {
    showToast('Please enter Vehicle Number!', 'error');
    return;
  }

  if (mobileNo && mobileNo.length !== 10) {
    showToast('Mobile number must be exactly 10 digits or leave it empty!', 'error');
    const mobInput = document.getElementById('p-mobile-no');
    if (mobInput) {
      mobInput.focus();
      mobInput.select();
    }
    return;
  }

  // Store draft payload pending barcode scan
  const now = new Date();
  const inDate = now.toLocaleDateString('en-GB');
  const entryTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  pendingSavePayload = {
    tokenNo,
    vehType,
    vehNo,
    custName,
    mobileNo,
    rate,
    paymentMode,
    inDate,
    entryTime
  };

  // Open Barcode Scan Modal
  document.getElementById('modal-token-display').textContent = tokenNo;
  document.getElementById('modal-veh-display').textContent = vehNo;
  document.getElementById('modal-rate-display').textContent = `₹${rate} (${paymentMode})`;

  const scanInput = document.getElementById('scan-barcode-input');
  const errorMsg = document.getElementById('barcode-scan-error-msg');
  if (scanInput) scanInput.value = '';
  if (errorMsg) errorMsg.classList.add('hidden');

  const modal = document.getElementById('barcode-modal');
  modal.classList.remove('hidden');

  setTimeout(() => {
    if (scanInput) scanInput.focus();
  }, 100);
}

// Confirm Scanned Barcode and Save Entry to PostgreSQL DB
async function confirmBarcodeScan(event) {
  if (event) event.preventDefault();

  if (!pendingSavePayload) return;

  const scanInput = document.getElementById('scan-barcode-input');
  const errorMsg = document.getElementById('barcode-scan-error-msg');
  const errorText = document.getElementById('barcode-scan-error-text');

  if (errorMsg) errorMsg.classList.add('hidden');

  const barcodeValue = scanInput ? scanInput.value.trim().toUpperCase() : '';
  const expectedToken = pendingSavePayload.tokenNo;

  let finalBarcode = barcodeValue;

  if (barcodeValue) {
    // Extract numeric portion from scanned card barcode
    const scannedDigits = barcodeValue.replace(/\D/g, '');
    const expectedDigits = expectedToken.toString();

    // Validate that token and card barcode number are identical
    if (!scannedDigits || scannedDigits !== expectedDigits) {
      const msg = 'Enter the correct barcode number';
      if (errorText && errorMsg) {
        errorText.textContent = msg;
        errorMsg.classList.remove('hidden');
      }
      showToast(msg, 'error');
      if (scanInput) {
        scanInput.select();
        scanInput.focus();
      }
      return;
    }
  } else {
    finalBarcode = `CARD-${expectedToken}`;
  }

  const payload = {
    ...pendingSavePayload,
    tokenNo: expectedToken,
    barcode: finalBarcode
  };

  try {
    const response = await fetch('/api/parking/entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.success) {
      const savedToken = data.tokenNo || expectedToken;
      const savedBarcode = data.barcode || finalBarcode;
      showToast(`Token #${savedToken} Saved & Linked to Card Barcode [${savedBarcode}]!`, 'success');
      closeBarcodeModal();
      resetParkingForm();
      loadParkingEntries();
    } else {
      const msg = data.message || 'Error saving token';
      if (errorText && errorMsg) {
        errorText.textContent = msg;
        errorMsg.classList.remove('hidden');
      }
      showToast(msg, 'error');
    }
  } catch (err) {
    console.error('Error saving entry:', err);
    showToast('Failed to save parking entry.', 'error');
  }
}

// Skip Card Scanning & Use Auto-Generated Barcode
function skipBarcodeScan() {
  if (!pendingSavePayload) return;
  document.getElementById('scan-barcode-input').value = `CARD-${pendingSavePayload.tokenNo}`;
  confirmBarcodeScan(null);
}

// Close Barcode Modal
function closeBarcodeModal() {
  const modal = document.getElementById('barcode-modal');
  const errorMsg = document.getElementById('barcode-scan-error-msg');
  if (modal) modal.classList.add('hidden');
  if (errorMsg) errorMsg.classList.add('hidden');
  pendingSavePayload = null;
}

let activeExitCheckoutEntry = null;

// Open Vehicle Exit Barcode Scan Modal (Exit - F12)
function openExitScanModal() {
  // Ensure history modal and other popups are closed
  closeExitHistoryModal();
  closeBarcodeModal();
  closeExitCheckoutModal();

  const modal = document.getElementById('exit-scan-modal');
  const scanInput = document.getElementById('scan-exit-barcode-input');
  const errorMsg = document.getElementById('exit-scan-error-msg');

  if (!modal || !scanInput) return;

  if (errorMsg) errorMsg.classList.add('hidden');

  // Always keep input clean and show 'scan barcode and token number' placeholder
  scanInput.value = '';
  scanInput.placeholder = 'scan barcode and token number';

  modal.classList.remove('hidden');

  setTimeout(() => {
    scanInput.focus();
  }, 100);
}

// Close Exit Scan Modal
function closeExitScanModal() {
  const modal = document.getElementById('exit-scan-modal');
  const errorMsg = document.getElementById('exit-scan-error-msg');
  if (modal) modal.classList.add('hidden');
  if (errorMsg) errorMsg.classList.add('hidden');
}

// Confirm Exit Barcode Scan & Fetch Vehicle Details
async function confirmExitBarcodeScan(event) {
  if (event) event.preventDefault();

  const scanInput = document.getElementById('scan-exit-barcode-input');
  const errorMsg = document.getElementById('exit-scan-error-msg');
  const errorText = document.getElementById('exit-scan-error-text');
  const query = scanInput ? scanInput.value.trim().toUpperCase() : '';

  if (errorMsg) errorMsg.classList.add('hidden');

  if (!query) return;

  try {
    const response = await fetch(`/api/parking/lookup?query=${encodeURIComponent(query)}`);
    const data = await response.json();

    if (data.success && data.entry) {
      const entry = data.entry;
      activeExitCheckoutEntry = entry;

      // Populate Exit Checkout Bill Modal (matching reference image)
      document.getElementById('exit-token-title').textContent = entry.token_no;
      document.getElementById('exit-token-no').textContent = entry.token_no;
      document.getElementById('exit-veh-type').textContent = entry.veh_type;
      document.getElementById('exit-veh-no').textContent = entry.veh_no;
      document.getElementById('exit-cust-name').textContent = entry.cust_name || '-';
      document.getElementById('exit-mobile-no').textContent = entry.mobile_no || '-';
      document.getElementById('exit-in-date').textContent = entry.in_date || '-';
      document.getElementById('exit-entry-time').textContent = entry.entry_time || '-';

      // Calculate Hours & Amount according to rule: for each 12 hrs, ₹15 (Bike/EV/Scooter) or ₹20 (Royal/Bullet)
      const rate = entry.rate || 15;
      const durationStr = calculateDaysAndHours(entry.in_date, entry.entry_time, entry.created_at);
      const elapsedHoursDecimal = getElapsedHoursDecimal(entry.in_date, entry.entry_time, entry.created_at);
      const calculatedAmount = computeParkingBillAmount(elapsedHoursDecimal, rate);
      entry.total_amount = calculatedAmount;

      document.getElementById('exit-hours').textContent = `${durationStr}`;
      document.getElementById('exit-rate').textContent = `₹${rate} / 12 hrs`;
      
      const totalAmountInput = document.getElementById('exit-total-amount');
      const editableAmountInput = document.getElementById('exit-editable-amount');
      const fineInput = document.getElementById('exit-fine-amount');
      
      entry.base_amount = calculatedAmount;
      if (fineInput) fineInput.value = 0;
      if (totalAmountInput) totalAmountInput.value = calculatedAmount;
      if (editableAmountInput) editableAmountInput.value = calculatedAmount;

      // Populate left-side form with vehicle details
      populateFormWithVehicleEntry(entry);

      // Close scan modal and open bill details modal
      closeExitScanModal();
      openExitCheckoutModal();
    } else {
      const msg = data.message || `No active vehicle found matching Token/Card [${query}]`;
      
      // Show inline error message inside modal
      if (errorText && errorMsg) {
        errorText.textContent = msg;
        errorMsg.classList.remove('hidden');
      }

      // Also display floating toast notification on top
      showToast(msg, 'error');

      // Select input for quick re-scanning
      if (scanInput) {
        scanInput.select();
        scanInput.focus();
      }
    }
  } catch (err) {
    console.error('Exit lookup error:', err);
    showToast('Failed to retrieve vehicle exit details.', 'error');
  }
}

// Populate left panel form with scanned vehicle details
function populateFormWithVehicleEntry(entry) {
  if (!entry) return;

  const tokenInput = document.getElementById('p-token-no');
  if (tokenInput) {
    tokenInput.value = entry.token_no;
  }

  const typeSelect = document.getElementById('p-veh-type');
  if (typeSelect) {
    typeSelect.value = entry.veh_type;
  }

  // Parse formula vehicle number (e.g. TN 67 AD 2007)
  const parts = (entry.veh_no || '').split(' ');
  if (parts.length >= 4) {
    document.getElementById('p-veh-s1').value = parts[0] || 'TN';
    document.getElementById('p-veh-s2').value = parts[1] || '';
    document.getElementById('p-veh-s3').value = parts[2] || '';
    document.getElementById('p-veh-s4').value = parts[3] || '';
  } else if (parts.length > 0) {
    document.getElementById('p-veh-s1').value = parts[0] || 'TN';
    document.getElementById('p-veh-s2').value = '';
    document.getElementById('p-veh-s3').value = '';
    document.getElementById('p-veh-s4').value = '';
  }

  const nameInput = document.getElementById('p-cust-name');
  if (nameInput) nameInput.value = entry.cust_name || '';

  const mobileInput = document.getElementById('p-mobile-no');
  if (mobileInput) mobileInput.value = entry.mobile_no || '';

  const rateInput = document.getElementById('p-rate');
  if (rateInput) rateInput.value = entry.rate || 15;
}

// Open Exit Checkout Modal
function openExitCheckoutModal() {
  const modal = document.getElementById('exit-checkout-modal');
  if (modal) modal.classList.remove('hidden');
}

// Close Exit Checkout Modal
function closeExitCheckoutModal() {
  const modal = document.getElementById('exit-checkout-modal');
  if (modal) modal.classList.add('hidden');
  activeExitCheckoutEntry = null;
}

// Toggle Enquiry Popover directly below Grey Info Button
function toggleEnquiryPopover(event) {
  if (event) event.stopPropagation();
  const popover = document.getElementById('enquiry-popover');
  const numbersText = document.getElementById('enquiry-numbers-text');
  const hint = document.getElementById('click-reveal-hint');

  if (!popover) return;

  const isHidden = popover.classList.contains('hidden');
  if (isHidden) {
    // Reset blur state when opening popover
    if (numbersText) {
      numbersText.classList.add('blur-sm');
      numbersText.classList.add('select-none');
    }
    if (hint) {
      hint.innerHTML = '<i class="fa-solid fa-hand-pointer mr-1 animate-bounce"></i> Click cursor to unblur numbers';
      hint.classList.remove('hidden');
    }
    popover.classList.remove('hidden');
  } else {
    popover.classList.add('hidden');
  }
}

// Reveal blurred enquiry contact numbers on cursor click
function revealEnquiryNumbers() {
  const numbersText = document.getElementById('enquiry-numbers-text');
  const hint = document.getElementById('click-reveal-hint');

  if (numbersText) {
    numbersText.classList.remove('blur-sm');
    numbersText.classList.remove('select-none');
  }

  if (hint) {
    hint.innerHTML = '<i class="fa-solid fa-circle-check mr-1 text-emerald-400"></i> <span class="text-emerald-400 font-bold">Numbers Unblurred & Revealed</span>';
  }
  showToast('Enquiry Contact: 8825467213 , 8124600699', 'info');
}

// Close popover when clicking anywhere outside
document.addEventListener('click', (e) => {
  const popover = document.getElementById('enquiry-popover');
  if (popover && !popover.classList.contains('hidden')) {
    if (!popover.contains(e.target) && !e.target.closest('button[onclick*="toggleEnquiryPopover"]')) {
      popover.classList.add('hidden');
    }
  }
});

let currentSelectedHistoryMonth = '';

// Load Available Months into History Modal Select Dropdown
async function loadHistoryMonths() {
  const monthSelect = document.getElementById('history-month-select');
  if (!monthSelect) return;

  try {
    const res = await fetch('/api/parking/history/months');
    const data = await res.json();

    if (data.success && data.months && data.months.length > 0) {
      currentSelectedHistoryMonth = data.currentMonth || data.months[0];
      monthSelect.innerHTML = data.months.map(m => {
        const [yyyy, mm] = m.split('-');
        const dateObj = new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, 1);
        const monthLabel = dateObj.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        const isCurrent = m === data.currentMonth;
        return `<option value="${m}" ${isCurrent ? 'selected' : ''}>${monthLabel} (${m})${isCurrent ? ' - Current Month' : ''}</option>`;
      }).join('') + `<option value="all">View All Months History</option>`;
      
      monthSelect.value = currentSelectedHistoryMonth;
    } else {
      const now = new Date();
      const currentYYYYMM = now.toISOString().slice(0, 7);
      currentSelectedHistoryMonth = currentYYYYMM;
      monthSelect.innerHTML = `<option value="${currentYYYYMM}">${now.toLocaleString('en-US', { month: 'long', year: 'numeric' })} (${currentYYYYMM}) - Current Month</option><option value="all">View All Months History</option>`;
    }
  } catch (err) {
    console.error('Failed to load history months:', err);
  }
}

// Handle Month Selector Change
function onHistoryMonthChange() {
  const monthSelect = document.getElementById('history-month-select');
  const searchInput = document.getElementById('history-search-input');
  if (monthSelect) {
    currentSelectedHistoryMonth = monthSelect.value;
  }
  loadExitHistory(searchInput ? searchInput.value : '', currentSelectedHistoryMonth);
}



// Open Exit History Modal (Triggered by View - F5 button with optional token search)
function openExitHistoryModal(initialSearchQuery = '') {
  const modal = document.getElementById('history-modal');
  const searchInput = document.getElementById('history-search-input');
  
  if (!modal) {
    console.error('history-modal not found');
    return;
  }

  // Hide any existing popups or scan modals first
  closeBarcodeModal();
  closeExitScanModal();
  closeExitCheckoutModal();

  if (searchInput) searchInput.value = initialSearchQuery;
  modal.classList.remove('hidden');
  modal.style.display = 'flex';

  // Load months dropdown and then load history for selected month
  loadHistoryMonths().then(() => {
    loadExitHistory(initialSearchQuery, currentSelectedHistoryMonth);
  });

  setTimeout(() => {
    if (searchInput) {
      searchInput.focus();
      if (initialSearchQuery) searchInput.select();
    }
  }, 100);
}

// Close Exit History Modal
function closeExitHistoryModal() {
  const modal = document.getElementById('history-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

// Filter Exit History
function filterExitHistory() {
  const query = (document.getElementById('history-search-input')?.value || '').trim();
  loadExitHistory(query, currentSelectedHistoryMonth);
}

// Print Monthly Exit History Report
function printExitHistory() {
  const printWindow = window.open('', '_blank');
  const gridBodyHtml = document.getElementById('history-grid-body')?.innerHTML || '';
  const count = document.getElementById('history-count-badge')?.textContent || '0';
  const totalRev = document.getElementById('history-total-revenue')?.textContent || '₹0';
  const cashRev = document.getElementById('history-cash-revenue')?.textContent || '₹0';
  const gpayRev = document.getElementById('history-gpay-revenue')?.textContent || '₹0';

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>SSA Parking - Monthly Exit History Report</title>
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; color: #0f172a; }
        h2 { margin-bottom: 2px; color: #0f172a; }
        .meta { font-size: 12px; color: #475569; margin-bottom: 15px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
        .summary-box { display: flex; gap: 15px; margin-bottom: 15px; }
        .card { background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 6px; font-size: 12px; }
        .card strong { font-size: 14px; color: #0f172a; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 11px; }
        th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
        th { background-color: #f1f5f9; font-weight: bold; }
        .text-center { text-align: center; }
        .text-right { text-align: right; }
      </style>
    </head>
    <body>
      <h2>SSA TWO-WHEELER PARKING SYSTEM</h2>
      <div class="meta">Monthly Vehicle Exit History Report | Month: ${currentSelectedHistoryMonth || 'Current'} | Generated: ${new Date().toLocaleString()}</div>
      <div class="summary-box">
        <div class="card">Total Exits: <strong>${count}</strong></div>
        <div class="card">Total Revenue: <strong>${totalRev}</strong></div>
        <div class="card">CASH: <strong>${cashRev}</strong></div>
        <div class="card">GPAY: <strong>${gpayRev}</strong></div>
      </div>
      <table>
        <thead>
          <tr>
            <th>SNo</th>
            <th>Token</th>
            <th>Barcode Card</th>
            <th>Veh Type</th>
            <th>Veh No</th>
            <th>Customer Name</th>
            <th>Mobile No</th>
            <th>Entry Time</th>
            <th>Exit Time</th>
            <th>Amount</th>
            <th>Payment</th>
          </tr>
        </thead>
        <tbody>
          ${gridBodyHtml}
        </tbody>
      </table>
      <script>window.onload = function() { window.print(); window.close(); }</script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

// Download Exit History CSV / Excel Report
function downloadExitHistoryCSV() {
  if (!cachedExitHistoryRecords || cachedExitHistoryRecords.length === 0) {
    showToast('No exit history records available to download.', 'error');
    return;
  }

  const headers = [
    'SNo',
    'Token No',
    'Barcode Card',
    'Vehicle Type',
    'Vehicle No',
    'Customer Name',
    'Mobile No',
    'In Date',
    'Entry Time',
    'Exit Date',
    'Exit Time',
    'Fine Amount (INR)',
    'Total Amount (INR)',
    'Payment Mode'
  ];

  const rows = cachedExitHistoryRecords.map((item, index) => {
    const sno = cachedExitHistoryRecords.length - index;
    const barcode = item.barcode || `CARD-${item.token_no}`;
    return [
      sno,
      `"${item.token_no}"`,
      `"${barcode}"`,
      `"${item.veh_type || 'BIKE 15'}"`,
      `"${item.veh_no || ''}"`,
      `"${(item.cust_name || '').replace(/"/g, '""')}"`,
      `"${item.mobile_no || ''}"`,
      `"${item.in_date || ''}"`,
      `"${item.entry_time || ''}"`,
      `"${item.exit_date || ''}"`,
      `"${item.exit_time || ''}"`,
      item.fine_amount || 0,
      item.total_amount || item.rate || 15,
      `"${(item.payment_mode || 'CASH').toUpperCase()}"`
    ].join(',');
  });

  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  const monthLabel = currentSelectedHistoryMonth || 'Current';
  link.setAttribute('href', url);
  link.setAttribute('download', `SSA_Exit_History_${monthLabel}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast('Exit history report downloaded successfully!', 'success');
}

// Update Exit Fine Amount & Add to Total Payable Bill
function updateExitFineAndTotal() {
  const fineInput = document.getElementById('exit-fine-amount');
  const detailInput = document.getElementById('exit-total-amount');
  const bannerInput = document.getElementById('exit-editable-amount');
  
  if (!fineInput || !detailInput || !bannerInput) return;

  const fineVal = parseFloat(fineInput.value) || 0;
  const baseFee = (activeExitCheckoutEntry && activeExitCheckoutEntry.base_amount) 
    ? activeExitCheckoutEntry.base_amount 
    : 15;

  const totalVal = Math.max(0, baseFee + fineVal);
  detailInput.value = totalVal;
  bannerInput.value = totalVal;

  if (activeExitCheckoutEntry) {
    activeExitCheckoutEntry.fine_amount = fineVal;
    activeExitCheckoutEntry.total_amount = totalVal;
  }
}

// Sync Editable Exit Payable Amount between detail box and big banner
function syncExitPayableAmount(source = 'banner') {
  const detailInput = document.getElementById('exit-total-amount');
  const bannerInput = document.getElementById('exit-editable-amount');
  if (!detailInput || !bannerInput) return;

  if (source === 'banner') {
    detailInput.value = bannerInput.value;
  } else {
    bannerInput.value = detailInput.value;
  }

  const val = parseFloat(bannerInput.value);
  if (activeExitCheckoutEntry && !isNaN(val)) {
    activeExitCheckoutEntry.total_amount = val;
  }
}

// Attach globally to window
window.openExitHistoryModal = openExitHistoryModal;
window.closeExitHistoryModal = closeExitHistoryModal;
window.filterExitHistory = filterExitHistory;
window.printExitHistory = printExitHistory;
window.downloadExitHistoryCSV = downloadExitHistoryCSV;
window.onHistoryMonthChange = onHistoryMonthChange;
window.triggerViewAction = triggerViewAction;
window.switchGridMode = switchGridMode;
window.syncExitPayableAmount = syncExitPayableAmount;
window.updateExitFineAndTotal = updateExitFineAndTotal;


let cachedExitHistoryRecords = [];

// Load Exit History Records from Backend (Supports Monthly Filter & Search)
async function loadExitHistory(searchQuery = '', month = '') {
  const gridBody = document.getElementById('history-grid-body');
  const countBadge = document.getElementById('history-count-badge');
  const totalRevEl = document.getElementById('history-total-revenue');
  const cashRevEl = document.getElementById('history-cash-revenue');
  const gpayRevEl = document.getElementById('history-gpay-revenue');

  if (!gridBody) return;

  const targetMonth = month || currentSelectedHistoryMonth;

  try {
    let url = '/api/parking/history?';
    const params = new URLSearchParams();
    if (searchQuery) params.append('search', searchQuery);
    if (targetMonth) params.append('month', targetMonth);
    
    url += params.toString();

    const response = await fetch(url);
    const data = await response.json();

    if (data.success) {
      cachedExitHistoryRecords = data.history || [];
      if (countBadge) countBadge.textContent = `${data.count} Records`;
      if (totalRevEl) totalRevEl.textContent = `₹${(data.summary?.totalAmount || 0).toLocaleString('en-IN')}`;
      if (cashRevEl) cashRevEl.textContent = `₹${(data.summary?.cashAmount || 0).toLocaleString('en-IN')}`;
      if (gpayRevEl) gpayRevEl.textContent = `₹${(data.summary?.gpayAmount || 0).toLocaleString('en-IN')}`;

      if (data.history && data.history.length > 0) {
        gridBody.innerHTML = data.history.map((item, index) => {
          const sno = data.history.length - index;
          const cardBarcode = item.barcode || `CARD-${item.token_no}`;
          const mode = (item.payment_mode || 'CASH').toUpperCase();

          return `
            <tr class="hover:bg-slate-100 transition border-b border-slate-200">
              <td class="py-2 px-2.5 border-r border-slate-200 text-center font-bold text-slate-700">${sno}</td>
              <td class="py-2 px-2.5 border-r border-slate-200 text-center font-extrabold text-sky-700 font-mono">${item.token_no}</td>
              <td class="py-2 px-2.5 border-r border-slate-200 text-center font-mono font-bold text-slate-600 text-[10px]">${cardBarcode}</td>
              <td class="py-2 px-2.5 border-r border-slate-200 font-bold text-slate-800">${item.veh_type || 'BIKE 15'}</td>
              <td class="py-2 px-2.5 border-r border-slate-200 font-extrabold text-slate-900 font-mono">${item.veh_no}</td>
              <td class="py-2 px-2.5 border-r border-slate-200 text-slate-800 font-medium">${item.cust_name || '-'}</td>
              <td class="py-2 px-2.5 border-r border-slate-200 text-slate-800 font-mono text-[10px]">${item.mobile_no || '-'}</td>
              <td class="py-2 px-2.5 border-r border-slate-200 text-slate-700 font-mono text-[10px] whitespace-nowrap">
                <span class="font-bold text-slate-500">${item.in_date}</span>
                <span class="text-slate-400 mx-0.5">·</span>
                <span class="text-slate-800 font-semibold">${item.entry_time}</span>
              </td>
              <td class="py-2 px-2.5 border-r border-slate-200 font-mono text-[10px] whitespace-nowrap">
                <span class="font-bold text-rose-500">${item.exit_date}</span>
                <span class="text-slate-400 mx-0.5">·</span>
                <span class="text-rose-700 font-semibold">${item.exit_time}</span>
              </td>
              <td class="py-2 px-2.5 border-r border-slate-200 text-right font-extrabold text-emerald-700 font-mono">₹${item.total_amount || item.rate || 15}</td>
              <td class="py-2 px-2.5 text-center text-slate-800 font-bold">
                <span class="px-2 py-0.5 rounded text-[10px] font-extrabold ${mode === 'GPAY' ? 'bg-sky-100 text-sky-800 border border-sky-300' : 'bg-emerald-100 text-emerald-800 border border-emerald-300'}">${mode}</span>
              </td>
            </tr>
          `;
        }).join('');
      } else {
        gridBody.innerHTML = `
          <tr>
            <td colspan="11" class="py-12 text-center text-slate-400 font-semibold">
              <i class="fa-solid fa-folder-open text-3xl mb-2 text-slate-300 block"></i>
              No exit history records found for ${targetMonth === 'all' ? 'any month' : `month [${targetMonth}]`}.
            </td>
          </tr>
        `;
      }
    }
  } catch (err) {
    console.error('Error loading exit history:', err);
  }
}

// Complete Vehicle Exit Checkout (Clears particular record)
async function completeVehicleExitCheckout() {
  if (!activeExitCheckoutEntry) return;

  const paymentMode = document.querySelector('input[name="exit_payment_mode"]:checked')?.value || 'CASH';
  const editableVal = document.getElementById('exit-editable-amount')?.value;
  const fineVal = parseFloat(document.getElementById('exit-fine-amount')?.value) || 0;
  const finalPayable = (editableVal !== '' && !isNaN(parseFloat(editableVal)))
    ? parseFloat(editableVal)
    : (activeExitCheckoutEntry.total_amount || 15);

  try {
    const response = await fetch('/api/parking/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenNo: activeExitCheckoutEntry.token_no,
        barcode: activeExitCheckoutEntry.barcode,
        paymentMode,
        fineAmount: fineVal,
        totalAmount: finalPayable
      })
    });

    const data = await response.json();

    if (data.success) {
      showToast(`Vehicle Token #${activeExitCheckoutEntry.token_no} Exit Completed & Record Cleared!`, 'success');
      closeExitCheckoutModal();
      closeExitScanModal();
      closeExitHistoryModal();
      resetParkingForm();
      loadParkingEntries();
    } else {
      showToast(data.message || 'Error processing vehicle exit', 'error');
    }
  } catch (err) {
    console.error('Error completing exit:', err);
    showToast('Failed to complete vehicle exit.', 'error');
  }
}

// Password Eye Toggle
function togglePasswordVisibility(inputId, iconId) {
  const passwordInput = document.getElementById(inputId);
  const icon = document.getElementById(iconId);

  if (passwordInput.type === 'password') {
    passwordInput.type = 'text';
    icon.classList.remove('fa-eye-slash');
    icon.classList.add('fa-eye');
    icon.classList.add('text-brand-600');
  } else {
    passwordInput.type = 'password';
    icon.classList.remove('fa-eye');
    icon.classList.remove('text-brand-600');
    icon.classList.add('fa-eye-slash');
  }
}

// Handle Login Submission
async function handleLogin(event) {
  event.preventDefault();
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');

  const username = usernameInput ? usernameInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!username || !password) {
    showToast('Please enter User Name and Password', 'error');
    return;
  }

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (data.success) {
      const userSession = {
        id: data.user.id,
        username: data.user.username,
        fullName: data.user.fullName,
        role: data.user.role,
        loggedInAt: new Date().toISOString()
      };
      sessionStorage.setItem('veloReg_session', JSON.stringify(userSession));
      showToast(`Login successful! Welcome, ${data.user.fullName}`, 'success');
      showDashboard(userSession);
    } else {
      showToast(data.message || 'Invalid credentials', 'error');
    }
  } catch (err) {
    console.warn('API fallback:', err);
    const fallbackSession = { username: username, fullName: username, role: 'owner' };
    sessionStorage.setItem('veloReg_session', JSON.stringify(fallbackSession));
    showDashboard(fallbackSession);
  }
}

let gridAutoRefreshInterval = null;

// Render Dashboard
function showDashboard(session) {
  const loginContainer = document.getElementById('login-container');
  const dashboardContainer = document.getElementById('dashboard-container');
  const footer = document.getElementById('main-footer');

  if (loginContainer && dashboardContainer) {
    loginContainer.classList.add('hidden');
    dashboardContainer.classList.remove('hidden');
    dashboardContainer.classList.add('flex');
    if (footer) footer.classList.add('hidden');

    getNextTokenNo();
    loadParkingEntries();
    setupEnterKeyNavigation();

    // Auto-refresh grid every 30 seconds to keep Days & Hours live-updated.
    // Only refreshes when the Active Vehicles tab is shown — if the user is
    // viewing Exit Vehicle DB, the interval does nothing so the page stays put.
    if (gridAutoRefreshInterval) clearInterval(gridAutoRefreshInterval);
    gridAutoRefreshInterval = setInterval(() => {
      if (currentGridMode === 'active') {
        loadParkingEntries();
      }
    }, 30000);
  }
}

// Logout Action
function handleLogout() {
  sessionStorage.removeItem('veloReg_session');
  localStorage.removeItem('veloReg_session');

  // Clear login inputs freshly for next user login
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  if (usernameInput) usernameInput.value = '';
  if (passwordInput) passwordInput.value = '';

  const loginContainer = document.getElementById('login-container');
  const dashboardContainer = document.getElementById('dashboard-container');
  const footer = document.getElementById('main-footer');

  if (loginContainer && dashboardContainer) {
    dashboardContainer.classList.add('hidden');
    dashboardContainer.classList.remove('flex');
    loginContainer.classList.remove('hidden');
    if (footer) footer.classList.remove('hidden');
  }

  showToast('Logged out of Parking System.', 'info');
}

// Get Next Token Number from PostgreSQL Server
async function getNextTokenNo() {
  try {
    const response = await fetch('/api/parking/next-token');
    const data = await response.json();
    const tokenInput = document.getElementById('p-token-no');
    if (data.success && data.nextToken && tokenInput) {
      tokenInput.placeholder = '000';
      tokenInput.value = '';
      tokenInput.setAttribute('data-auto-token', data.nextToken);
    }
  } catch (err) {
    console.error('Error getting next token:', err);
  }
}

// Vehicle Type Rate Auto Adjust & Custom "OTHER" Vehicle Type Toggle
function updateRateByVehicleType() {
  const typeSelect = document.getElementById('p-veh-type');
  const rateInput = document.getElementById('p-rate');
  const otherContainer = document.getElementById('p-veh-type-other-container');
  const otherInput = document.getElementById('p-veh-type-other');

  if (!typeSelect || !rateInput) return;

  const val = typeSelect.value;

  // Default rates per vehicle type (₹15 for Bike/EV/Scooter, ₹20 for Royal/Bullet per 12 hrs)
  const rateMap = {
    'BIKE 15': 15,
    'BIKE':    15,
    'EV BIKE': 15,
    'ROYAL':   20,
    'SCOOTER': 15,
    'BULLET':  20
  };
  rateInput.value = rateMap[val] !== undefined ? rateMap[val] : 15;

  // Toggle Custom "OTHER" Input Field
  if (val === 'OTHER') {
    if (otherContainer) otherContainer.classList.remove('hidden');
    if (otherInput) otherInput.focus();
  } else {
    if (otherContainer) otherContainer.classList.add('hidden');
  }
}

// Reset Form & Clear Search Filters / Reload Active Grid (Clear - Esc)
function resetParkingForm() {
  const s1 = document.getElementById('p-veh-s1');
  const s2 = document.getElementById('p-veh-s2');
  const s3 = document.getElementById('p-veh-s3');
  const s4 = document.getElementById('p-veh-s4');
  
  if (s1) s1.value = 'TN';
  if (s2) s2.value = '';
  if (s3) s3.value = '';
  if (s4) s4.value = '';

  const custNameInput = document.getElementById('p-cust-name');
  const mobileNoInput = document.getElementById('p-mobile-no');
  const vehTypeSelect = document.getElementById('p-veh-type');
  const rateInput = document.getElementById('p-rate');
  const cashRadio = document.querySelector('input[name="payment_mode"][value="CASH"]');
  const otherContainer = document.getElementById('p-veh-type-other-container');
  const otherInput = document.getElementById('p-veh-type-other');

  if (custNameInput) custNameInput.value = '';
  if (mobileNoInput) mobileNoInput.value = '';
  if (vehTypeSelect) vehTypeSelect.value = 'BIKE 15';
  if (rateInput) rateInput.value = 15;
  if (cashRadio) cashRadio.checked = true;
  if (otherInput) otherInput.value = '';
  if (otherContainer) otherContainer.classList.add('hidden');

  // Clear all search bar inputs
  const gridSearchInput = document.getElementById('grid-search-input');
  const historySearchInput = document.getElementById('history-search-input');
  if (gridSearchInput) gridSearchInput.value = '';
  if (historySearchInput) historySearchInput.value = '';

  // Reset grid back to Active Vehicles mode and reload fresh list
  switchGridMode('active');
  loadParkingEntries('');

  getNextTokenNo();

  if (s2) s2.focus();

  showToast('Form cleared & active parking grid refreshed!', 'info');
}

let currentGridMode = 'active'; // 'active' or 'history'

// Trigger View Action (View - F5 Button & F5 Key Shortcut - First searches Active Vehicles, then Exit History)
async function triggerViewAction() {
  const tokenVal = (document.getElementById('p-token-no')?.value || '').trim();
  const currentVehNo = getFormattedVehicleNumber();
  const gridSearch = (document.getElementById('grid-search-input')?.value || '').trim();

  let searchQuery = '';
  if (tokenVal && tokenVal !== '000') {
    searchQuery = tokenVal;
  } else if (currentVehNo && currentVehNo !== 'TN') {
    searchQuery = currentVehNo;
  } else if (gridSearch) {
    searchQuery = gridSearch;
  }

  const gridSearchInput = document.getElementById('grid-search-input');
  if (searchQuery && gridSearchInput) {
    gridSearchInput.value = searchQuery;
  }

  if (!searchQuery) {
    // If no search term provided, default to Exit History view
    switchGridMode('history');
    openExitHistoryModal('');
    return;
  }

  // 1. FIRST: Search Active Vehicles in database
  try {
    const activeRes = await fetch(`/api/parking/entries?search=${encodeURIComponent(searchQuery)}`);
    const activeData = await activeRes.json();

    if (activeData.success && activeData.entries && activeData.entries.length > 0) {
      // Active vehicle found! Display in Active Vehicles grid view
      switchGridMode('active');
      loadParkingEntries(searchQuery);
      showToast(`Found ${activeData.entries.length} Active Vehicle(s) matching "${searchQuery}"`, 'success');
      return;
    }
  } catch (err) {
    console.error('Error checking active entries:', err);
  }

  // 2. SECOND: If not found in Active Vehicles, search in Exit History database
  switchGridMode('history');
  openExitHistoryModal(searchQuery);
  showToast(`No Active Vehicle found. Searching Exit History for "${searchQuery}"...`, 'info');
}

// Switch Right-Panel Data Grid between Active Vehicles & Exit History Database
function switchGridMode(mode) {
  currentGridMode = mode || 'active';
  const activeBtn = document.getElementById('tab-active-btn');
  const historyBtn = document.getElementById('tab-history-btn');
  const gdriveBarBtn = document.getElementById('btn-gdrive-backup-bar');
  const searchInput = document.getElementById('grid-search-input');
  const colInDate = document.getElementById('grid-col-indate');
  const colTime   = document.getElementById('grid-col-time');
  const gridBody  = document.getElementById('parking-grid-body');

  // Clear grid body immediately to prevent stale row rendering during tab switch
  if (gridBody) {
    gridBody.innerHTML = `
      <tr>
        <td colspan="10" class="py-6 text-center text-slate-400 font-semibold">
          <i class="fa-solid fa-spinner fa-spin text-brand-700 mr-2"></i> Loading ${currentGridMode === 'active' ? 'Active Vehicles' : 'Exit History'}...
        </td>
      </tr>
    `;
  }

  if (gdriveBarBtn) {
    gdriveBarBtn.classList.remove('hidden');
  }

  if (activeBtn && historyBtn) {
    if (currentGridMode === 'active') {
      activeBtn.className = 'px-2.5 py-1 bg-brand-700 text-white font-bold text-xs rounded shadow-xs transition flex items-center gap-1 cursor-pointer';
      historyBtn.className = 'px-2.5 py-1 bg-slate-300 hover:bg-slate-400 text-slate-800 font-bold text-xs rounded transition flex items-center gap-1 cursor-pointer';
      // Restore active-mode column headers
      if (colInDate) colInDate.textContent = 'InDate';
      if (colTime)   colTime.textContent   = 'entryTime';
    } else {
      activeBtn.className = 'px-2.5 py-1 bg-slate-300 hover:bg-slate-400 text-slate-800 font-bold text-xs rounded transition flex items-center gap-1 cursor-pointer';
      historyBtn.className = 'px-2.5 py-1 bg-brand-700 text-white font-bold text-xs rounded shadow-xs transition flex items-center gap-1 cursor-pointer';
      // Change column headers to reflect exit history context
      if (colInDate) colInDate.textContent = 'InDate';
      if (colTime)   colTime.textContent   = 'OutDate';
    }
  }

  const query = searchInput ? searchInput.value.trim() : '';
  if (currentGridMode === 'active') {
    loadParkingEntries(query);
  } else {
    loadExitHistoryGrid(query);
  }
}

// Filter Data Grid by Barcode or Search Term
function filterParkingGrid() {
  const searchVal = (document.getElementById('grid-search-input')?.value || '').trim();
  if (currentGridMode === 'history') {
    loadExitHistoryGrid(searchVal);
  } else {
    loadParkingEntries(searchVal);
  }
}

// Load Exit History Table into Main Right-Panel Data Grid (queries exit_history database)
async function loadExitHistoryGrid(searchQuery = '') {
  const gridBody = document.getElementById('parking-grid-body');
  if (!gridBody) return;

  // Strict mode guard: ensure user hasn't switched away to active vehicles tab
  if (currentGridMode !== 'history') return;

  try {
    const url = searchQuery 
      ? `/api/parking/history?search=${encodeURIComponent(searchQuery)}`
      : '/api/parking/history';

    const response = await fetch(url);
    const data = await response.json();

    // Re-check mode after async fetch to prevent race condition
    if (currentGridMode !== 'history') return;

    if (data.success && data.history && data.history.length > 0) {
      gridBody.innerHTML = data.history.map((item, index) => {
        const sno = data.history.length - index;
        const exitTimeStr = `${item.exit_date} ${item.exit_time}`;
        // Pass exited_at so the parked-duration timer is frozen at actual exit time
        const durationDisplay = calculateDaysAndHours(item.in_date, item.entry_time, item.exited_at, item.exited_at);
        const mode = (item.payment_mode || 'CASH').toUpperCase();

        return `
          <tr class="hover:bg-slate-200 transition">
            <td class="py-1 px-2 border-r border-slate-300 text-center font-bold text-slate-800">${sno}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-center font-bold text-sky-700 font-mono">${item.token_no}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-slate-800 font-bold">${item.veh_type || 'BIKE 15'}</td>
            <td class="py-1 px-2 border-r border-slate-300 font-bold text-slate-900 font-mono">${item.veh_no}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-slate-800">${item.cust_name || '-'}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-slate-800 font-mono font-bold">${item.mobile_no || '-'}</td>
            <td class="py-1 px-2 border-r border-slate-300 font-mono text-[10px] whitespace-nowrap">
              <span class="font-bold text-slate-500">${item.in_date || '-'}</span>
              <span class="text-slate-400 mx-0.5">·</span>
              <span class="text-slate-800 font-semibold">${item.entry_time || '-'}</span>
            </td>
            <td class="py-1 px-2 border-r border-slate-300 font-mono text-[10px] whitespace-nowrap">
              <span class="font-bold text-rose-500">${item.exit_date || '-'}</span>
              <span class="text-slate-400 mx-0.5">·</span>
              <span class="text-rose-700 font-semibold">${item.exit_time || '-'}</span>
            </td>
            <td class="py-1 px-2 border-r border-slate-300 text-center text-amber-700 font-extrabold font-mono">${durationDisplay}</td>
            <td class="py-1 px-2 text-center font-extrabold text-emerald-700 font-mono">₹${item.total_amount || item.rate || 15} (${mode})</td>
          </tr>
        `;
      }).join('');
    } else {
      if (currentGridMode !== 'history') return;
      gridBody.innerHTML = `
        <tr>
          <td colspan="10" class="py-8 text-center text-slate-400 font-semibold">No exited vehicle history records found in database.</td>
        </tr>
      `;
    }
  } catch (err) {
    console.error('Error fetching exit history grid:', err);
  }
}

// Calculate elapsed duration in Days and Hours (e.g., "0D 2H" or "1D 5H")
// Pass `untilDateStr` (ISO string) to freeze the calculation at exit time (stops timer for exited vehicles)
function calculateDaysAndHours(inDateStr, entryTimeStr, createdAtStr, untilDateStr) {
  try {
    let entryDate = null;

    if (inDateStr && entryTimeStr) {
      let day, month, year;
      const dateParts = inDateStr.trim().split(/[\/\-]/);
      if (dateParts.length === 3) {
        if (dateParts[0].length === 4) {
          year = parseInt(dateParts[0], 10);
          month = parseInt(dateParts[1], 10) - 1;
          day = parseInt(dateParts[2], 10);
        } else {
          day = parseInt(dateParts[0], 10);
          month = parseInt(dateParts[1], 10) - 1;
          year = parseInt(dateParts[2], 10);
        }
      }

      const timeMatch = entryTimeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (year && month !== undefined && day && timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        let m = parseInt(timeMatch[2], 10);
        const ampm = timeMatch[3] ? timeMatch[3].toUpperCase() : '';

        if (ampm === 'PM' && h < 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;

        entryDate = new Date(year, month, day, h, m, 0);
      }
    }

    if ((!entryDate || isNaN(entryDate.getTime())) && createdAtStr) {
      entryDate = new Date(createdAtStr);
    }

    if (!entryDate || isNaN(entryDate.getTime())) {
      return '0D 0H';
    }

    // Use the exit time (untilDateStr) if provided — freezes the timer for exited vehicles
    const until = (untilDateStr && new Date(untilDateStr).getTime() > 0)
      ? new Date(untilDateStr)
      : new Date();

    const diffMs = Math.max(0, until.getTime() - entryDate.getTime());
    const totalMinutes = Math.floor(diffMs / (1000 * 60));

    const days = Math.floor(totalMinutes / (24 * 60));
    const remainingMinutes = totalMinutes % (24 * 60);
    const hours = Math.floor(remainingMinutes / 60);

    return `${days}D ${hours}H`;
  } catch (err) {
    console.error('Error calculating elapsed duration:', err);
    return '0D 0H';
  }
}

// Calculate total elapsed decimal hours from entry time to now
function getElapsedHoursDecimal(inDateStr, entryTimeStr, createdAtStr) {
  try {
    let entryDate = null;
    if (inDateStr && entryTimeStr) {
      let day, month, year;
      const dateParts = inDateStr.trim().split(/[\/\-]/);
      if (dateParts.length === 3) {
        if (dateParts[0].length === 4) {
          year = parseInt(dateParts[0], 10);
          month = parseInt(dateParts[1], 10) - 1;
          day = parseInt(dateParts[2], 10);
        } else {
          day = parseInt(dateParts[0], 10);
          month = parseInt(dateParts[1], 10) - 1;
          year = parseInt(dateParts[2], 10);
        }
      }

      const timeMatch = entryTimeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (year && month !== undefined && day && timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        let m = parseInt(timeMatch[2], 10);
        const ampm = timeMatch[3] ? timeMatch[3].toUpperCase() : '';

        if (ampm === 'PM' && h < 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;

        entryDate = new Date(year, month, day, h, m, 0);
      }
    }

    if ((!entryDate || isNaN(entryDate.getTime())) && createdAtStr) {
      entryDate = new Date(createdAtStr);
    }

    if (!entryDate || isNaN(entryDate.getTime())) {
      return 1;
    }

    const now = new Date();
    const diffMs = Math.max(0, now.getTime() - entryDate.getTime());
    return Math.max(0.01, diffMs / (1000 * 60 * 60));
  } catch (err) {
    return 1;
  }
}

// Compute total parking bill according to exact rule:
// For each 12 hrs (or part thereof), baseRate applies (₹15 for Bike/EV/Scooter, ₹20 for Royal/Bullet)
function computeParkingBillAmount(elapsedHours, baseRate = 15) {
  const hrs = Math.max(0.01, elapsedHours);
  const periods = Math.ceil(hrs / 12.0);
  return Math.max(1, periods) * baseRate;
}

// Load Parking Data Grid Table (View F5)
async function loadParkingEntries(searchQuery = '') {
  const gridBody = document.getElementById('parking-grid-body');
  if (!gridBody) return;

  // Guard against race condition: don't populate active grid if user switched tabs
  if (currentGridMode !== 'active') return;

  try {
    const url = searchQuery 
      ? `/api/parking/entries?search=${encodeURIComponent(searchQuery)}`
      : '/api/parking/entries';

    const response = await fetch(url);
    const data = await response.json();

    // Guard check after async fetch: ensure grid mode is still active
    if (currentGridMode !== 'active') return;

    if (data.success && data.entries.length > 0) {
      gridBody.innerHTML = data.entries.map((item, index) => {
        const sno = data.entries.length - index;
        const durationDisplay = calculateDaysAndHours(item.in_date, item.entry_time, item.created_at);
        const elapsedHoursDecimal = getElapsedHoursDecimal(item.in_date, item.entry_time, item.created_at);
        const currentAmt = computeParkingBillAmount(elapsedHoursDecimal, item.rate || 15);

        return `
          <tr class="hover:bg-slate-200 transition">
            <td class="py-1 px-2 border-r border-slate-300 text-center font-bold text-slate-800">${sno}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-center font-bold text-sky-700">${item.token_no}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-slate-800">${item.veh_type}</td>
            <td class="py-1 px-2 border-r border-slate-300 font-bold text-slate-900">${item.veh_no}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-slate-800">${item.cust_name || ''}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-slate-800 font-mono font-bold">${item.mobile_no || ''}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-slate-700">${item.in_date}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-slate-800 font-bold">${item.entry_time}</td>
            <td class="py-1 px-2 border-r border-slate-300 text-center text-amber-700 font-extrabold font-mono">${durationDisplay}</td>
            <td class="py-1 px-2 text-center text-emerald-700 font-extrabold font-mono">₹${currentAmt}</td>
          </tr>
        `;
      }).join('');
    } else {
      if (currentGridMode !== 'active') return;
      gridBody.innerHTML = `
        <tr>
          <td colspan="10" class="py-8 text-center text-slate-400 font-semibold">No matching parking records found.</td>
        </tr>
      `;
    }
  } catch (err) {
    console.error('Error fetching parking grid:', err);
  }
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  
  let bgColors = 'bg-slate-900 text-white';
  let iconClass = 'fa-info-circle text-sky-400';
  
  if (type === 'success') {
    bgColors = 'bg-emerald-900 text-white border border-emerald-700';
    iconClass = 'fa-circle-check text-emerald-400';
  } else if (type === 'error') {
    bgColors = 'bg-rose-900 text-white border border-rose-700';
    iconClass = 'fa-triangle-exclamation text-rose-400';
  }

  toast.className = `p-3 rounded-lg shadow-xl flex items-center gap-3 text-xs font-bold transform transition-all duration-200 translate-y-2 opacity-0 pointer-events-auto ${bgColors}`;
  toast.innerHTML = `
    <i class="fa-solid ${iconClass} text-sm"></i>
    <span class="flex-1">${message}</span>
    <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-white ml-2">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;

  container.appendChild(toast);

  setTimeout(() => toast.classList.remove('translate-y-2', 'opacity-0'), 10);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 200);
  }, 3500);
}

// Email Current Month Active Vehicles Records
async function backupCurrentMonthToDrive() {
  const btn = document.getElementById('btn-gdrive-backup-bar');
  const originalHtml = btn ? btn.innerHTML : '';

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Sending Email...`;
    }

    const response = await fetch('/api/parking/export-active-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();

    if (data.success) {
      alert(`✅ ${data.message || 'Current month active vehicles emailed successfully!'}`);
    } else {
      alert(`⚠️ Email export failed: ${data.message}`);
    }
  } catch (err) {
    alert(`❌ Error exporting active vehicles via email: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

// =========================================================================
// EMAIL FILE UPLOAD MODAL CONTROLLERS & FORM SUBMISSION
// =========================================================================

function openEmailUploadModal() {
  const modal = document.getElementById('email-upload-modal');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closeEmailUploadModal() {
  const modal = document.getElementById('email-upload-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
  const form = document.getElementById('email-upload-form');
  if (form) {
    form.reset();
  }
}

async function handleEmailUploadSubmit(event) {
  event.preventDefault();

  const submitBtn = document.getElementById('eu-submit-btn');
  const btnText = document.getElementById('eu-btn-text');
  const originalBtnText = btnText ? btnText.textContent : 'Send Email with Attachments';

  const name = document.getElementById('eu-name')?.value?.trim();
  const phone = document.getElementById('eu-phone')?.value?.trim();
  const vehicleNumber = document.getElementById('eu-veh-no')?.value?.trim();
  const vehicleType = document.getElementById('eu-veh-type')?.value;
  const email = document.getElementById('eu-email')?.value?.trim();
  const notes = document.getElementById('eu-notes')?.value?.trim();
  const fileInput = document.getElementById('eu-files');

  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast('Please select at least one file to attach.', 'error');
    return;
  }

  // Construct FormData for multipart/form-data request
  const formData = new FormData();
  formData.append('name', name || '');
  formData.append('phone', phone || '');
  formData.append('vehicleNumber', vehicleNumber || '');
  formData.append('vehicleType', vehicleType || '');
  formData.append('email', email || '');
  formData.append('notes', notes || '');

  // Append all attached files
  for (let i = 0; i < fileInput.files.length; i++) {
    formData.append('files', fileInput.files[i]);
  }

  try {
    if (submitBtn) submitBtn.disabled = true;
    if (btnText) btnText.textContent = 'Sending Email...';

    const response = await fetch('/api/upload-email', {
      method: 'POST',
      body: formData // multipart/form-data handled automatically by browser with boundary
    });

    const result = await response.json();

    if (result.success) {
      showToast(result.message || 'Email sent successfully with file attachments!', 'success');
      closeEmailUploadModal();
    } else {
      showToast(result.message || 'Failed to send email upload.', 'error');
    }
  } catch (err) {
    console.error('Email upload error:', err);
    showToast(`Error sending email: ${err.message}`, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (btnText) btnText.textContent = originalBtnText;
  }
}

