import { 
  initializeApp, 
  getApps, 
  getApp,
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc,
  collection, 
  getDocs, 
  onSnapshot, 
  runTransaction, 
  serverTimestamp, 
  query, 
  orderBy,
  where,
  limit,
  addDoc,
  getAuth, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject
} from "./firebase-bundle.js";

import { firebaseConfig, INITIAL_PRODUCTS, canonicalizeProductId, generateProductSlug } from "./firebase-config.js";

// Initialize Firebase App
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore with specific database ID if configured
const db = firebaseConfig.firestoreDatabaseId 
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId) 
  : getFirestore(app);

const auth = getAuth(app);

let storage = null;
try {
  storage = getStorage(app);
} catch (e) {
  console.warn("[ZENVORA] Firebase Storage init notice:", e.message);
}

/**
 * Seed initial products into Firestore if missing from the products collection.
 * Runs idempotently in background.
 */
export async function seedProductsIfEmpty() {
  try {
    const productsCol = collection(db, "products");
    const snapshot = await getDocs(productsCol);
    const existingIds = new Set(snapshot.docs.map(d => d.id));
    const missing = INITIAL_PRODUCTS.filter(p => !existingIds.has(p.productId));
    
    if (missing.length > 0) {
      console.log(`[ZENVORA] Seeding ${missing.length} missing products into Firestore...`);
      const batchPromises = missing.map(p => {
        const docRef = doc(db, "products", p.productId);
        return setDoc(docRef, {
          ...p,
          updatedAt: new Date().toISOString()
        });
      });
      await Promise.all(batchPromises);
      console.log("[ZENVORA] Missing products successfully seeded in Firestore.");
    }
  } catch (err) {
    console.warn("[ZENVORA] Product seeding check warning:", err.message);
  }
}

/**
 * Get a single product document from Firestore.
 */
export async function getProduct(productId) {
  const canonicalId = canonicalizeProductId(productId);
  try {
    const docRef = doc(db, "products", canonicalId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return { productId: canonicalId, exists: true, ...snap.data() };
    }
    console.error(`[ZENVORA] Product document not found in Firestore for Product ID: "${canonicalId}"`);
    return { productId: canonicalId, exists: false, error: 'not_found' };
  } catch (err) {
    console.error(`[ZENVORA] Error fetching product ${productId}:`, err);
    return { productId: canonicalId, exists: false, error: 'error', rawError: err };
  }
}

/**
 * Listen to real-time updates for all products.
 */
export function subscribeToProducts(callback, errorCallback) {
  const productsCol = collection(db, "products");
  return onSnapshot(productsCol, (snapshot) => {
    const products = [];
    snapshot.forEach(docSnap => {
      products.push({ productId: docSnap.id, exists: true, ...docSnap.data() });
    });
    callback(products);
  }, (err) => {
    if (err && (err.code === 'cancelled' || err.name === 'AbortError' || String(err.message || '').toLowerCase().includes('abort'))) {
      return;
    }
    console.error("[ZENVORA] Firestore products subscription error:", err);
    if (typeof errorCallback === 'function') errorCallback(err);
  });
}

/**
 * Listen to real-time updates for a single product with comprehensive error handling.
 */
export function subscribeToProduct(productId, callback, errorCallback) {
  const canonicalId = canonicalizeProductId(productId);
  const docRef = doc(db, "products", canonicalId);
  return onSnapshot(docRef, (snap) => {
    if (snap.exists()) {
      callback({ productId: snap.id, exists: true, ...snap.data() });
    } else {
      console.error(`[ZENVORA] Stock document not found in Firestore for Product ID: "${canonicalId}"`);
      if (typeof callback === 'function') {
        callback({ productId: canonicalId, exists: false, error: 'not_found' });
      }
    }
  }, (err) => {
    if (err && (err.code === 'cancelled' || err.name === 'AbortError' || String(err.message || '').toLowerCase().includes('abort'))) {
      return;
    }
    console.error(`[ZENVORA] Firestore error for Product ID: "${canonicalId}":`, err);
    const isPermission = err && (err.code === 'permission-denied' || String(err.message || '').includes('permission'));
    if (typeof errorCallback === 'function') {
      errorCallback(err);
    } else if (typeof callback === 'function') {
      callback({
        productId: canonicalId,
        exists: false,
        error: isPermission ? 'permission_denied' : 'error',
        rawError: err
      });
    }
  });
}

/**
 * Atomic stock deduction and order creation transaction.
 * 
 * Verifies that all cart items exist, have adequate stock, validates authoritative
 * server prices, deducts stock, and creates the order document in Firestore.
 * 
 * @param {Object} orderData - Customer information & cart items
 * @returns {Promise<{success: boolean, orderId?: string, error?: string}>}
 */
export async function createOrderWithStockDeduction(orderData) {
  const { customerName, phone, province, city, area, address, items } = orderData;

  if (!items || items.length === 0) {
    return { success: false, error: "Your shopping bag is empty." };
  }

  // Generate unique order ID: ZV-YYYYMMDD-XXXX
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const orderId = `ZV-${dateStr}-${randomSuffix}`;
  const orderDocRef = doc(db, "orders", orderId);

  // 30 minute cancellation window
  const createdAtIso = now.toISOString();
  const cancellationDeadline = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

  try {
    const result = await runTransaction(db, async (transaction) => {
      // 1. Read all product documents involved in the order
      const productDocs = [];
      for (const item of items) {
        const canonicalId = canonicalizeProductId(item.id || item.productId);
        const pRef = doc(db, "products", canonicalId);
        const pSnap = await transaction.get(pRef);

        let pData;
        if (!pSnap.exists()) {
          // If product doesn't exist yet in Firestore, initialize from seed definition
          const seed = INITIAL_PRODUCTS.find(p => p.productId === canonicalId);
          if (!seed) {
            throw new Error(`Product "${item.name || item.productName}" is no longer available in the catalogue.`);
          }
          pData = { ...seed };
          transaction.set(pRef, { ...seed, updatedAt: createdAtIso });
        } else {
          pData = pSnap.data();
        }

        const requestedQty = Number(item.quantity) || 1;
        const currentStock = typeof pData.stock === 'number' ? pData.stock : 0;
        const itemColor = (item.color || 'Standard').trim();

        // Check if product has variants and item specifies a color
        let matchedVariant = null;
        let productVariants = Array.isArray(pData.variants) ? JSON.parse(JSON.stringify(pData.variants)) : null;

        if (productVariants && productVariants.length > 0 && itemColor && itemColor !== 'Standard') {
          const vIdx = productVariants.findIndex(
            v => v.name && v.name.toLowerCase() === itemColor.toLowerCase()
          );
          if (vIdx !== -1) {
            matchedVariant = { ...productVariants[vIdx], index: vIdx };
            const variantStock = typeof matchedVariant.stock === 'number' ? matchedVariant.stock : 0;
            if (variantStock < requestedQty) {
              if (variantStock <= 0) {
                throw new Error(`Sorry, "${pData.productName || item.name}" in ${matchedVariant.name} is currently Out of Stock.`);
              } else {
                throw new Error(`Sorry, only ${variantStock} item(s) available for "${pData.productName || item.name}" in ${matchedVariant.name}.`);
              }
            }
          }
        }

        // If no matching variant or standard color, check overall product stock
        if (!matchedVariant) {
          if (currentStock < requestedQty) {
            if (currentStock <= 0) {
              throw new Error(`Sorry, "${pData.productName || item.name}" is currently Out of Stock.`);
            } else {
              throw new Error(`Sorry, only ${currentStock} item(s) available for "${pData.productName || item.name}".`);
            }
          }
        }

        productDocs.push({
          ref: pRef,
          currentStock,
          requestedQty,
          authoritativePrice: (matchedVariant && matchedVariant.price) ? matchedVariant.price : (pData.price || item.price),
          productName: pData.productName || item.name,
          productId: canonicalId,
          image: (matchedVariant && matchedVariant.image) ? matchedVariant.image : (pData.image || item.image || ""),
          size: item.size || "Standard",
          color: itemColor,
          sku: (matchedVariant && matchedVariant.sku) ? matchedVariant.sku : (pData.sku || item.sku || ""),
          matchedVariant,
          allVariants: productVariants
        });
      }

      // 2. Perform stock deductions
      let verifiedTotal = 0;
      const verifiedItems = [];

      for (const p of productDocs) {
        let updatePayload = {};
        if (p.allVariants && p.matchedVariant) {
          // Deduct variant stock
          const vIdx = p.matchedVariant.index;
          const newVarStock = Math.max(0, p.matchedVariant.stock - p.requestedQty);
          p.allVariants[vIdx].stock = newVarStock;
          p.allVariants[vIdx].status = newVarStock <= 0 ? "out_of_stock" : "available";

          // Calculate new total stock
          const newTotalStock = p.allVariants
            .filter(v => v.enabled !== false)
            .reduce((sum, v) => sum + (Number(v.stock) || 0), 0);

          updatePayload = {
            variants: p.allVariants,
            stock: newTotalStock,
            status: newTotalStock <= 0 ? "out_of_stock" : "available",
            updatedAt: createdAtIso
          };
        } else {
          const newStock = Math.max(0, p.currentStock - p.requestedQty);
          const newStatus = newStock <= 0 ? "out_of_stock" : "available";
          updatePayload = {
            stock: newStock,
            status: newStatus,
            updatedAt: createdAtIso
          };
        }

        transaction.update(p.ref, updatePayload);

        const subtotal = p.authoritativePrice * p.requestedQty;
        verifiedTotal += subtotal;

        verifiedItems.push({
          productId: p.productId,
          productName: p.productName,
          price: p.authoritativePrice,
          quantity: p.requestedQty,
          subtotal,
          image: p.image,
          size: p.size,
          color: p.color,
          sku: p.sku
        });
      }

      // 3. Write order document
      const orderRecord = {
        orderId,
        customerName: customerName.trim(),
        phone: phone.trim(),
        province: province.trim(),
        city: city.trim(),
        area: area.trim(),
        address: address.trim(),
        items: verifiedItems,
        total: verifiedTotal,
        status: "Pending",
        createdAt: createdAtIso,
        cancellationDeadline,
        stockRestored: false,
        updatedAt: createdAtIso
      };

      transaction.set(orderDocRef, orderRecord);

      return { orderId, total: verifiedTotal, items: verifiedItems };
    });

    return { success: true, ...result };
  } catch (err) {
    console.error("[ZENVORA] Order creation transaction failed:", err);
    return { success: false, error: err.message || "Failed to process order." };
  }
}

/**
 * Cancel an order within the 30-minute grace period and atomically restore stock.
 */
export async function cancelOrder(orderId) {
  const trimmedId = String(orderId || "").trim();
  if (!trimmedId) return { success: false, error: "Invalid Order ID." };

  const orderDocRef = doc(db, "orders", trimmedId);

  try {
    const result = await runTransaction(db, async (transaction) => {
      const orderSnap = await transaction.get(orderDocRef);
      if (!orderSnap.exists()) {
        throw new Error("Order not found. Please verify your Order ID.");
      }

      const order = orderSnap.data();

      if (order.status === "Cancelled") {
        throw new Error("This order has already been cancelled.");
      }

      if (["Shipped", "Delivered"].includes(order.status)) {
        throw new Error(`Order cannot be cancelled because it is already ${order.status.toLowerCase()}.`);
      }

      // Verify 30-minute window
      const now = new Date().getTime();
      const deadline = new Date(order.cancellationDeadline).getTime();
      if (now > deadline) {
        throw new Error("The 30-minute cancellation window for this order has expired. Please contact support via WhatsApp (03232974451).");
      }

      const nowIso = new Date().toISOString();

      // Restore stock for all order items if not already restored
      if (!order.stockRestored && Array.isArray(order.items)) {
        for (const item of order.items) {
          const canonicalId = canonicalizeProductId(item.productId || item.id);
          const pRef = doc(db, "products", canonicalId);
          const pSnap = await transaction.get(pRef);

          if (pSnap.exists()) {
            const pData = pSnap.data();
            const qty = Number(item.quantity) || 1;
            const itemColor = (item.color || 'Standard').trim();

            if (Array.isArray(pData.variants) && pData.variants.length > 0 && itemColor && itemColor !== 'Standard') {
              const updatedVariants = JSON.parse(JSON.stringify(pData.variants));
              const vIdx = updatedVariants.findIndex(v => v.name && v.name.toLowerCase() === itemColor.toLowerCase());
              if (vIdx !== -1) {
                updatedVariants[vIdx].stock = (Number(updatedVariants[vIdx].stock) || 0) + qty;
                updatedVariants[vIdx].status = "available";
                const newTotalStock = updatedVariants
                  .filter(v => v.enabled !== false)
                  .reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
                transaction.update(pRef, {
                  variants: updatedVariants,
                  stock: newTotalStock,
                  status: "available",
                  updatedAt: nowIso
                });
              } else {
                const currentStock = pData.stock || 0;
                transaction.update(pRef, {
                  stock: currentStock + qty,
                  status: "available",
                  updatedAt: nowIso
                });
              }
            } else {
              const currentStock = pData.stock || 0;
              const restoredStock = currentStock + qty;
              transaction.update(pRef, {
                stock: restoredStock,
                status: "available",
                updatedAt: nowIso
              });
            }
          }
        }
      }

      // Mark order as Cancelled
      transaction.update(orderDocRef, {
        status: "Cancelled",
        cancelledAt: nowIso,
        stockRestored: true,
        updatedAt: nowIso
      });

      return { orderId: trimmedId };
    });

    return { success: true, ...result };
  } catch (err) {
    console.error(`[ZENVORA] Failed to cancel order ${trimmedId}:`, err);
    return { success: false, error: err.message || "Failed to cancel order." };
  }
}

/**
 * Get an order by its orderId.
 */
export async function getOrder(orderId) {
  const trimmedId = String(orderId || "").trim();
  if (!trimmedId) return null;
  try {
    const docRef = doc(db, "orders", trimmedId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return { orderId: snap.id, ...snap.data() };
    }
    return null;
  } catch (err) {
    console.error(`[ZENVORA] Error fetching order ${orderId}:`, err);
    return null;
  }
}

/**
 * Upload a product image to Firebase Storage with progress tracking.
 * Returns { success: true, downloadUrl, filePath } or informative error.
 */
export async function uploadProductImage(file, productId, progressCallback) {
  if (!storage) {
    return {
      success: false,
      error: "Firebase Storage is not initialized or configured in this environment.",
      storageNotConfigured: true
    };
  }

  const cleanId = String(productId || "uploads").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const safeName = file.name ? file.name.replace(/[^a-zA-Z0-9._-]/g, "_") : "product-image.jpg";
  const filePath = `products/${cleanId}/${Date.now()}_${safeName}`;
  const storageRef = ref(storage, filePath);

  try {
    const uploadTask = uploadBytesResumable(storageRef, file, {
      contentType: file.type || "image/jpeg",
      cacheControl: "public, max-age=31536000"
    });

    return new Promise((resolve) => {
      uploadTask.on(
        "state_changed",
        (snapshot) => {
          const progress = snapshot.totalBytes > 0 
            ? (snapshot.bytesTransferred / snapshot.totalBytes) * 100 
            : 0;
          if (typeof progressCallback === "function") {
            progressCallback(Math.round(progress));
          }
        },
        (error) => {
          console.error("[ZENVORA] Firebase Storage upload error:", error);
          const isPerm = error.code === 'storage/unauthorized' || String(error.message || '').includes('permission');
          resolve({
            success: false,
            error: error.message || "Failed to upload image to Firebase Storage",
            storageNotConfigured: isPerm,
            code: error.code
          });
        },
        async () => {
          try {
            const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
            resolve({
              success: true,
              downloadUrl,
              filePath,
              name: file.name,
              size: file.size
            });
          } catch (urlErr) {
            resolve({ success: false, error: urlErr.message });
          }
        }
      );
    });
  } catch (err) {
    console.error("[ZENVORA] Upload exception:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Check if a product has existing customer orders in Firestore.
 */
export async function checkProductHasOrders(productId) {
  const canonicalId = canonicalizeProductId(productId);
  try {
    const ordersCol = collection(db, "orders");
    const snap = await getDocs(ordersCol);
    let orderCount = 0;
    let recentOrderId = null;
    snap.forEach((docSnap) => {
      const order = docSnap.data();
      if (Array.isArray(order.items)) {
        const found = order.items.some(
          it => canonicalizeProductId(it.productId || it.id) === canonicalId
        );
        if (found) {
          orderCount++;
          if (!recentOrderId) recentOrderId = order.orderId || docSnap.id;
        }
      }
    });
    return { hasOrders: orderCount > 0, orderCount, recentOrderId };
  } catch (err) {
    console.warn("[ZENVORA] checkProductHasOrders warning:", err);
    return { hasOrders: false, orderCount: 0 };
  }
}

/**
 * Create a new dynamic product in Firestore.
 */
export async function createProduct(productData) {
  const {
    productId,
    productName,
    price,
    originalPrice,
    category,
    image,
    images = [],
    stock,
    status = "published",
    variants = [],
    sizes = [],
    description = "",
    shortDescription = "",
    brand = "ZENVORA SHOOP",
    sku = "",
    fabric = "",
    features = [],
    tags = [],
    isFeatured = false,
    shippingInfo = "Fast doorstep delivery across Karachi (2-3 days). Cash on Delivery available.",
    seo = {}
  } = productData;

  const canonicalId = String(productId || "").trim().toLowerCase();
  if (!canonicalId) throw new Error("Product ID / Slug is required.");
  if (!productName || !String(productName).trim()) throw new Error("Product Name is required.");
  if (typeof price !== 'number' || isNaN(price) || price < 0) throw new Error("A valid selling price (PKR) is required.");
  if (!image) throw new Error("At least one main product image is required.");

  // Check if product ID already exists
  const docRef = doc(db, "products", canonicalId);
  const snap = await getDoc(docRef);
  if (snap.exists()) {
    throw new Error(`A product with ID or Slug "${canonicalId}" already exists. Please choose a unique slug.`);
  }

  // Calculate authoritative stock from variants if variants are present and enabled
  let finalStock = Number(stock) || 0;
  let normalizedVariants = [];
  if (Array.isArray(variants) && variants.length > 0) {
    normalizedVariants = variants.map((v, idx) => ({
      id: v.id || `var-${idx + 1}`,
      name: String(v.name || "").trim(),
      hex: v.hex || "#111111",
      stock: Math.max(0, parseInt(v.stock, 10) || 0),
      sku: v.sku ? String(v.sku).trim() : `${canonicalId}-${(v.name || 'var').toLowerCase().replace(/\s+/g, '-')}`,
      price: (typeof v.price === 'number' && v.price > 0) ? v.price : price,
      image: v.image || image,
      enabled: v.enabled !== false,
      status: (parseInt(v.stock, 10) || 0) <= 0 ? "out_of_stock" : "available"
    }));
    finalStock = normalizedVariants
      .filter(v => v.enabled)
      .reduce((acc, v) => acc + v.stock, 0);
  }

  const finalStatus = status === "draft" 
    ? "draft" 
    : (finalStock <= 0 ? "out_of_stock" : "available");

  const nowIso = new Date().toISOString();
  const productPayload = {
    productId: canonicalId,
    productName: productName.trim(),
    slug: canonicalId,
    productUrl: `product.html?id=${canonicalId}`,
    category: category ? category.trim() : "Fashion",
    price: Number(price),
    originalPrice: (typeof originalPrice === 'number' && originalPrice > price) ? originalPrice : null,
    stock: finalStock,
    status: finalStatus,
    image,
    images: images.length > 0 ? images : [image],
    variants: normalizedVariants,
    sizes: Array.isArray(sizes) ? sizes : [],
    description: description.trim(),
    shortDescription: shortDescription.trim(),
    brand: brand.trim(),
    sku: sku.trim(),
    fabric: fabric.trim(),
    features: Array.isArray(features) ? features : [],
    tags: Array.isArray(tags) ? tags : [],
    isFeatured: Boolean(isFeatured),
    shippingInfo: shippingInfo.trim(),
    seo: {
      metaTitle: (seo && seo.metaTitle) ? seo.metaTitle : `${productName.trim()} | ZENVORA SHOOP`,
      metaDescription: (seo && seo.metaDescription) ? seo.metaDescription : `Shop ${productName.trim()} at ZENVORA SHOOP. Authentic Pakistani fashion online with Cash on Delivery Pakistan & WhatsApp orders.`,
      focusKeyword: (seo && seo.focusKeyword) ? seo.focusKeyword : productName.trim().toLowerCase(),
      additionalKeywords: (seo && seo.additionalKeywords) ? seo.additionalKeywords : "",
      canonicalUrl: (seo && seo.canonicalUrl) ? seo.canonicalUrl : `https://zenvorashoop.netlify.app/product.html?id=${canonicalId}`,
      ogTitle: (seo && seo.ogTitle) ? seo.ogTitle : `${productName.trim()} | ZENVORA SHOOP`,
      ogDescription: (seo && seo.ogDescription) ? seo.ogDescription : `Shop authentic ${productName.trim()} at ZENVORA SHOOP.`,
      ogImage: (seo && seo.ogImage) ? seo.ogImage : image
    },
    createdAt: nowIso,
    updatedAt: nowIso
  };

  await setDoc(docRef, productPayload);
  return { success: true, product: productPayload };
}

/**
 * Update an existing product document in Firestore.
 */
export async function updateProduct(productId, productData) {
  const canonicalId = canonicalizeProductId(productId);
  const docRef = doc(db, "products", canonicalId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) {
    throw new Error(`Product "${canonicalId}" not found in database.`);
  }

  const existing = snap.data();
  const price = typeof productData.price === 'number' ? productData.price : (existing.price || 0);
  
  let finalStock = typeof productData.stock === 'number' ? productData.stock : existing.stock;
  let normalizedVariants = productData.variants !== undefined ? productData.variants : (existing.variants || []);
  
  if (Array.isArray(normalizedVariants) && normalizedVariants.length > 0) {
    normalizedVariants = normalizedVariants.map((v, idx) => ({
      id: v.id || `var-${idx + 1}`,
      name: String(v.name || "").trim(),
      hex: v.hex || "#111111",
      stock: Math.max(0, parseInt(v.stock, 10) || 0),
      sku: v.sku ? String(v.sku).trim() : `${canonicalId}-${(v.name || 'var').toLowerCase().replace(/\s+/g, '-')}`,
      price: (typeof v.price === 'number' && v.price > 0) ? v.price : price,
      image: v.image || productData.image || existing.image || "",
      enabled: v.enabled !== false,
      status: (parseInt(v.stock, 10) || 0) <= 0 ? "out_of_stock" : "available"
    }));
    finalStock = normalizedVariants
      .filter(v => v.enabled)
      .reduce((acc, v) => acc + v.stock, 0);
  }

  const requestedStatus = productData.status || existing.status;
  const finalStatus = requestedStatus === "draft"
    ? "draft"
    : (finalStock <= 0 ? "out_of_stock" : "available");

  const nowIso = new Date().toISOString();
  const updates = {
    ...productData,
    stock: finalStock,
    status: finalStatus,
    variants: normalizedVariants,
    updatedAt: nowIso
  };

  await updateDoc(docRef, updates);
  return { success: true, product: { ...existing, ...updates } };
}

/**
 * Safely delete a product or require unpublishing if customer orders exist.
 */
export async function deleteProduct(productId, force = false) {
  const canonicalId = canonicalizeProductId(productId);
  const orderCheck = await checkProductHasOrders(canonicalId);
  if (orderCheck.hasOrders && !force) {
    return {
      success: false,
      hasOrders: true,
      orderCount: orderCheck.orderCount,
      recentOrderId: orderCheck.recentOrderId,
      error: `Product is referenced in ${orderCheck.orderCount} customer order(s) (e.g. #${orderCheck.recentOrderId}). To preserve customer order and sales history, please unpublish or set status to Draft instead.`
    };
  }

  const docRef = doc(db, "products", canonicalId);
  await deleteDoc(docRef);
  return { success: true, deletedId: canonicalId };
}

/**
 * Update product stock and price directly (Admin only).
 * Intelligently supports colour variants if present.
 */
export async function adminUpdateProduct(productId, updates) {
  const canonicalId = canonicalizeProductId(productId);
  const docRef = doc(db, "products", canonicalId);
  const nowIso = new Date().toISOString();
  
  const payload = {
    ...updates,
    updatedAt: nowIso
  };

  if (Array.isArray(updates.variants) && updates.variants.length > 0) {
    const total = updates.variants
      .filter(v => v.enabled !== false)
      .reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
    payload.stock = total;
    payload.status = total <= 0 ? "out_of_stock" : "available";
  } else if (typeof updates.stock === "number") {
    payload.status = updates.stock <= 0 ? "out_of_stock" : "available";
  }

  await updateDoc(docRef, payload);
  return { success: true };
}

/**
 * Update order status (Admin only).
 */
export async function adminUpdateOrderStatus(orderId, newStatus) {
  const docRef = doc(db, "orders", orderId);
  const nowIso = new Date().toISOString();
  await updateDoc(docRef, {
    status: newStatus,
    updatedAt: nowIso
  });
  return { success: true };
}

/**
 * ==========================================
 * ZENVORA SHOOP MEMBERSHIP SYSTEM SERVICES
 * ==========================================
 */

/**
 * Normalize membership code to clean uppercase trimmed string.
 * e.g. " zv-mem-000125 " -> "ZV-MEM-000125"
 */
export function normalizeMembershipCode(code) {
  if (!code) return "";
  return String(code).trim().toUpperCase();
}

/**
 * Format a Date object or string into standard "DD MMMM YYYY" (e.g. "25 September 2026")
 */
export function formatMembershipDate(dateInput) {
  try {
    const d = dateInput ? new Date(dateInput) : new Date();
    if (isNaN(d.getTime())) return String(dateInput || "");
    const day = d.getDate();
    const months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return String(dateInput || "");
  }
}

/**
 * Calculate the next sequential membership code given existing members.
 * Default pattern: ZV-MEM-000001, ZV-MEM-000002, etc.
 */
export function getNextSequentialMembershipCode(membersList = []) {
  let maxSeq = 0;
  const regex = /^ZV-MEM-(\d+)$/i;
  for (const m of membersList) {
    const code = normalizeMembershipCode(m.membershipCode || m.id);
    const match = code.match(regex);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }
  const nextNum = maxSeq + 1;
  return `ZV-MEM-${String(nextNum).padStart(6, '0')}`;
}

/**
 * Fetch a single member document by membership code.
 * Used by customer lookup and admin verification.
 */
export async function getMember(membershipCode) {
  const code = normalizeMembershipCode(membershipCode);
  if (!code) return { exists: false, error: "Empty code" };
  try {
    const memberDocRef = doc(db, "members", code);
    const snap = await getDoc(memberDocRef);
    if (snap.exists()) {
      return { exists: true, membershipCode: code, ...snap.data() };
    }
    return { exists: false };
  } catch (err) {
    console.error(`[ZENVORA] Error fetching member ${code}:`, err);
    return { exists: false, error: err.message };
  }
}

/**
 * Subscribe to all members (for Admin Stock panel real-time management).
 */
export function subscribeToMembers(callback, errorCallback) {
  const membersCol = collection(db, "members");
  return onSnapshot(membersCol, (snapshot) => {
    const members = [];
    snapshot.forEach(docSnap => {
      members.push({ id: docSnap.id, membershipCode: docSnap.id, ...docSnap.data() });
    });
    // Sort by createdAt descending
    members.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    callback(members);
  }, (err) => {
    console.error("[ZENVORA] Error in members subscription:", err);
    if (typeof errorCallback === "function") errorCallback(err);
  });
}

/**
 * Create a new member in Firestore.
 * Prevents duplicate membership codes.
 */
export async function createMember(memberData) {
  const code = normalizeMembershipCode(memberData.membershipCode);
  if (!code) {
    throw new Error("Membership Code is required.");
  }
  if (!memberData.name || !memberData.name.trim()) {
    throw new Error("Customer Name is required.");
  }
  if (!memberData.phone || !memberData.phone.trim()) {
    throw new Error("WhatsApp / Phone Number is required.");
  }

  const memberDocRef = doc(db, "members", code);
  const existing = await getDoc(memberDocRef);
  if (existing.exists()) {
    throw new Error(`Membership code "${code}" already exists. Please choose or generate a unique code.`);
  }

  const nowIso = new Date().toISOString();
  const joinedDateStr = memberData.joinedDate && memberData.joinedDate.trim() 
    ? memberData.joinedDate.trim() 
    : formatMembershipDate(new Date());

  const payload = {
    name: memberData.name.trim(),
    phone: memberData.phone.trim(),
    email: (memberData.email || "").trim(),
    membershipCode: code,
    joinedDate: joinedDateStr,
    notes: (memberData.notes || "").trim(),
    createdAt: nowIso,
    updatedAt: nowIso
  };

  await setDoc(memberDocRef, payload);
  return { success: true, member: payload };
}

/**
 * Update an existing member's information.
 * If membership code changes, handles atomic key transition and copies purchase history.
 */
export async function updateMember(originalCode, updatedData) {
  const oldCode = normalizeMembershipCode(originalCode);
  const newCode = normalizeMembershipCode(updatedData.membershipCode || originalCode);

  if (!oldCode) throw new Error("Original membership code required.");
  if (!newCode) throw new Error("Updated membership code cannot be empty.");
  if (!updatedData.name || !updatedData.name.trim()) throw new Error("Customer Name is required.");
  if (!updatedData.phone || !updatedData.phone.trim()) throw new Error("Phone Number is required.");

  const nowIso = new Date().toISOString();
  const payload = {
    name: updatedData.name.trim(),
    phone: updatedData.phone.trim(),
    email: (updatedData.email || "").trim(),
    membershipCode: newCode,
    joinedDate: updatedData.joinedDate ? updatedData.joinedDate.trim() : formatMembershipDate(new Date()),
    notes: (updatedData.notes || "").trim(),
    updatedAt: nowIso
  };

  if (oldCode === newCode) {
    const docRef = doc(db, "members", oldCode);
    await updateDoc(docRef, payload);
    return { success: true, membershipCode: oldCode };
  } else {
    // Code has changed: check if newCode is already taken
    const newDocRef = doc(db, "members", newCode);
    const checkSnap = await getDoc(newDocRef);
    if (checkSnap.exists()) {
      throw new Error(`Membership code "${newCode}" already belongs to another member.`);
    }

    // Get old purchases to migrate
    const oldPurchasesCol = collection(db, "members", oldCode, "purchases");
    const oldPurchasesSnap = await getDocs(oldPurchasesCol);
    const purchasesToMigrate = [];
    oldPurchasesSnap.forEach(snap => purchasesToMigrate.push({ id: snap.id, data: snap.data() }));

    // Create new member doc
    const oldDocRef = doc(db, "members", oldCode);
    const oldSnap = await getDoc(oldDocRef);
    const createdAt = (oldSnap.exists() && oldSnap.data().createdAt) ? oldSnap.data().createdAt : nowIso;

    await setDoc(newDocRef, { ...payload, createdAt });

    // Migrate purchases
    for (const p of purchasesToMigrate) {
      await setDoc(doc(db, "members", newCode, "purchases", p.id), p.data);
      await deleteDoc(doc(db, "members", oldCode, "purchases", p.id));
    }

    // Delete old doc
    await deleteDoc(oldDocRef);

    return { success: true, membershipCode: newCode };
  }
}

/**
 * Safely delete a member and all their purchase sub-records.
 */
export async function deleteMember(membershipCode) {
  const code = normalizeMembershipCode(membershipCode);
  if (!code) throw new Error("Membership code is required to delete.");

  // Delete all purchases in subcollection
  const purchasesCol = collection(db, "members", code, "purchases");
  const pSnap = await getDocs(purchasesCol);
  for (const pDoc of pSnap.docs) {
    await deleteDoc(doc(db, "members", code, "purchases", pDoc.id));
  }

  // Delete parent member document
  const memberDocRef = doc(db, "members", code);
  await deleteDoc(memberDocRef);

  return { success: true };
}

/**
 * Fetch all purchases for a specific member.
 */
export async function getMemberPurchases(membershipCode) {
  const code = normalizeMembershipCode(membershipCode);
  if (!code) return [];
  try {
    const purchasesCol = collection(db, "members", code, "purchases");
    const snap = await getDocs(purchasesCol);
    const purchases = [];
    snap.forEach(d => {
      purchases.push({ id: d.id, ...d.data() });
    });
    // Sort by purchaseDate descending
    purchases.sort((a, b) => new Date(b.purchaseDate || b.createdAt || 0) - new Date(a.purchaseDate || a.createdAt || 0));
    return purchases;
  } catch (err) {
    console.error(`[ZENVORA] Error fetching purchases for ${code}:`, err);
    return [];
  }
}

/**
 * Subscribe to real-time purchases for a specific member.
 */
export function subscribeToMemberPurchases(membershipCode, callback, errorCallback) {
  const code = normalizeMembershipCode(membershipCode);
  if (!code) return () => {};
  const purchasesCol = collection(db, "members", code, "purchases");
  return onSnapshot(purchasesCol, (snapshot) => {
    const purchases = [];
    snapshot.forEach(d => {
      purchases.push({ id: d.id, ...d.data() });
    });
    purchases.sort((a, b) => new Date(b.purchaseDate || b.createdAt || 0) - new Date(a.purchaseDate || a.createdAt || 0));
    callback(purchases);
  }, (err) => {
    console.error(`[ZENVORA] Error in purchases subscription for ${code}:`, err);
    if (typeof errorCallback === "function") errorCallback(err);
  });
}

/**
 * Add a purchase to a member's subcollection.
 * Automatically gives +1 star and updates purchase records.
 */
export async function addMemberPurchase(membershipCode, purchaseData) {
  const code = normalizeMembershipCode(membershipCode);
  if (!code) throw new Error("Membership code is required.");
  if (!purchaseData.productName || !purchaseData.productName.trim()) {
    throw new Error("Product Name is required.");
  }
  const qty = parseInt(purchaseData.quantity, 10);
  const amount = parseFloat(purchaseData.amount);
  if (isNaN(qty) || qty <= 0) throw new Error("Quantity must be a positive integer.");
  if (isNaN(amount) || amount < 0) throw new Error("Amount must be a valid non-negative number.");

  const purchasesCol = collection(db, "members", code, "purchases");
  const purchaseId = purchaseData.purchaseId 
    ? String(purchaseData.purchaseId).trim() 
    : `PUR-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

  const nowIso = new Date().toISOString();
  const payload = {
    productName: purchaseData.productName.trim(),
    productId: (purchaseData.productId || "").trim(),
    purchaseDate: purchaseData.purchaseDate ? purchaseData.purchaseDate.trim() : formatMembershipDate(new Date()),
    quantity: qty,
    amount: amount,
    orderId: (purchaseData.orderId || "").trim(),
    notes: (purchaseData.notes || "").trim(),
    createdAt: nowIso,
    updatedAt: nowIso
  };

  const pDocRef = doc(purchasesCol, purchaseId);
  await setDoc(pDocRef, payload);
  return { success: true, id: purchaseId, purchaseId, purchase: payload };
}

/**
 * Update an existing purchase.
 */
export async function updateMemberPurchase(membershipCode, purchaseId, purchaseData) {
  const code = normalizeMembershipCode(membershipCode);
  if (!code || !purchaseId) throw new Error("Member code and purchase ID required.");

  const qty = parseInt(purchaseData.quantity, 10);
  const amount = parseFloat(purchaseData.amount);
  if (isNaN(qty) || qty <= 0) throw new Error("Quantity must be a positive integer.");
  if (isNaN(amount) || amount < 0) throw new Error("Amount must be a valid non-negative number.");

  const pDocRef = doc(db, "members", code, "purchases", purchaseId);
  const nowIso = new Date().toISOString();
  const payload = {
    productName: purchaseData.productName.trim(),
    productId: (purchaseData.productId || "").trim(),
    purchaseDate: purchaseData.purchaseDate ? purchaseData.purchaseDate.trim() : formatMembershipDate(new Date()),
    quantity: qty,
    amount: amount,
    orderId: (purchaseData.orderId || "").trim(),
    notes: (purchaseData.notes || "").trim(),
    updatedAt: nowIso
  };

  await updateDoc(pDocRef, payload);
  return { success: true };
}

/**
 * Delete a purchase from a member's record.
 * Automatically decreases star count and updates total spending.
 */
export async function deleteMemberPurchase(membershipCode, purchaseId) {
  const code = normalizeMembershipCode(membershipCode);
  if (!code || !purchaseId) throw new Error("Member code and purchase ID required.");
  const pDocRef = doc(db, "members", code, "purchases", purchaseId);
  await deleteDoc(pDocRef);
  return { success: true };
}

// Export modules
export { 
  db, 
  auth, 
  storage,
  uploadProductImage,
  createProduct,
  updateProduct,
  deleteProduct,
  checkProductHasOrders,
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  collection, 
  getDocs, 
  onSnapshot, 
  query, 
  orderBy, 
  where, 
  limit, 
  addDoc,
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
};

