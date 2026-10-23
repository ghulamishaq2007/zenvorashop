import {
  db,
  auth,
  storage,
  uploadProductImage,
  createProduct,
  updateProduct,
  deleteProduct,
  checkProductHasOrders,
  adminUpdateProduct,
  getProduct,
  subscribeToProducts
} from "./firebase-service.js";
import { INITIAL_PRODUCTS, canonicalizeProductId, generateProductSlug } from "./firebase-config.js";

// State
let uploadedImages = []; // Array of { url, isMain, name, size, isUploading, progress }
let colourVariants = []; // Array of { id, name, hex, stock, sku, price, image, enabled }
let currentEditingProductId = null;
let allAdminProducts = [];
let featuresList = [];

// Quick common colors
const COMMON_COLORS = [
  { name: "Blue", hex: "#1E3A8A" },
  { name: "Green", hex: "#065F46" },
  { name: "Yellow", hex: "#EAB308" },
  { name: "Black", hex: "#111827" },
  { name: "White", hex: "#FFFFFF" },
  { name: "Red", hex: "#DC2626" },
  { name: "Navy", hex: "#0F172A" },
  { name: "Maroon", hex: "#800000" },
  { name: "Pink", hex: "#EC4899" },
  { name: "Grey", hex: "#6B7280" },
  { name: "Brown", hex: "#78350F" },
  { name: "Tan", hex: "#D97706" }
];

/**
 * Client-side Canvas Image Optimizer.
 * Downscales images over 1600px width/height and compresses to high-quality WebP.
 */
async function optimizeImageFile(file) {
  if (file.type === "image/svg+xml" || file.size < 350 * 1024) {
    return file;
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1600;
        let width = img.width;
        let height = img.height;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (blob && blob.size < file.size) {
              const optFile = new File([blob], file.name.replace(/\.[^.]+$/, ".webp"), {
                type: "image/webp"
              });
              resolve(optFile);
            } else {
              resolve(file);
            }
          },
          "image/webp",
          0.88
        );
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

/**
 * File to Data URL fallback helper.
 */
function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * Initialize Add Product tab on open
 */
export function initAddProductTab() {
  renderUploadedImages();
  renderVariants();
  renderFeatures();
  loadCatalogueTable();
  setupSlugSync();
  setupCharCounters();
}

/**
 * Set up real-time slug synchronization from product name
 */
function setupSlugSync() {
  const nameInput = document.getElementById("product-name-input");
  const slugInput = document.getElementById("product-slug-input");
  if (!nameInput || !slugInput) return;

  nameInput.addEventListener("input", () => {
    if (!currentEditingProductId) {
      const generated = generateProductSlug(nameInput.value);
      slugInput.value = generated;
      updateCanonicalPreview(generated);
    }
  });

  slugInput.addEventListener("input", () => {
    const clean = generateProductSlug(slugInput.value);
    updateCanonicalPreview(clean);
  });
}

function updateCanonicalPreview(slug) {
  const canonicalPreview = document.getElementById("product-canonical-preview");
  if (canonicalPreview) {
    canonicalPreview.textContent = `https://zenvorashoop.netlify.app/product.html?id=${slug || 'your-product-slug'}`;
  }
}

/**
 * Character count indicators for SEO fields
 */
function setupCharCounters() {
  const titleInput = document.getElementById("product-seo-title");
  const descInput = document.getElementById("product-seo-desc");
  const titleCount = document.getElementById("seo-title-count");
  const descCount = document.getElementById("seo-desc-count");

  if (titleInput && titleCount) {
    titleInput.addEventListener("input", () => {
      const len = titleInput.value.length;
      titleCount.textContent = `${len} / 60 chars`;
      titleCount.style.color = (len >= 45 && len <= 60) ? "#059669" : (len > 60 ? "#DC2626" : "#6B7280");
    });
  }

  if (descInput && descCount) {
    descInput.addEventListener("input", () => {
      const len = descInput.value.length;
      descCount.textContent = `${len} / 160 chars`;
      descCount.style.color = (len >= 130 && len <= 160) ? "#059669" : (len > 160 ? "#DC2626" : "#6B7280");
    });
  }
}

/**
 * Handle image file selection (upload to Firebase Storage or optimize)
 */
export async function handleImageUploadFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  const statusEl = document.getElementById("image-upload-status");
  const currentSlug = document.getElementById("product-slug-input")?.value || "products";

  if (statusEl) {
    statusEl.style.display = "block";
    statusEl.textContent = `Optimizing and uploading ${files.length} image(s)...`;
    statusEl.className = "alert-info";
  }

  for (const rawFile of files) {
    if (!rawFile.type.startsWith("image/")) {
      alert(`File "${rawFile.name}" is not an image. Only JPG, PNG, and WebP are supported.`);
      continue;
    }

    const tempIndex = uploadedImages.length;
    uploadedImages.push({
      url: "",
      isMain: uploadedImages.length === 0,
      name: rawFile.name,
      size: (rawFile.size / 1024).toFixed(0) + " KB",
      isUploading: true,
      progress: 10
    });
    renderUploadedImages();

    try {
      const optimized = await optimizeImageFile(rawFile);
      uploadedImages[tempIndex].progress = 40;
      renderUploadedImages();

      // Attempt Firebase Storage upload
      const uploadRes = await uploadProductImage(optimized, currentSlug, (progress) => {
        if (uploadedImages[tempIndex]) {
          uploadedImages[tempIndex].progress = Math.max(40, progress);
          renderUploadedImages();
        }
      });

      if (uploadRes && uploadRes.success && uploadRes.downloadUrl) {
        uploadedImages[tempIndex].url = uploadRes.downloadUrl;
        uploadedImages[tempIndex].isUploading = false;
        uploadedImages[tempIndex].progress = 100;
      } else {
        // If Firebase Storage failed or is not enabled, use the optimized permanent Data URL
        console.warn("[ZENVORA] Storage notice, using client asset:", uploadRes?.error);
        const dataUrl = await fileToDataUrl(optimized);
        uploadedImages[tempIndex].url = dataUrl;
        uploadedImages[tempIndex].isUploading = false;
        uploadedImages[tempIndex].progress = 100;
        uploadedImages[tempIndex].isLocal = true;

        if (uploadRes?.storageNotConfigured && statusEl) {
          statusEl.style.display = "block";
          statusEl.className = "alert-warning";
          statusEl.innerHTML = `
            <strong>Note on Image Storage:</strong> Firebase Storage is currently restricted or not activated in the Firebase Console.
            Images are saved in high-res format for local deployment. To use Firebase cloud URLs, enable Storage in Firebase Console.
          `;
        }
      }
    } catch (err) {
      console.error("Image processing error:", err);
      uploadedImages.splice(tempIndex, 1);
      alert(`Failed to process image ${rawFile.name}: ${err.message}`);
    }

    renderUploadedImages();
  }

  if (statusEl && !statusEl.classList.contains("alert-warning")) {
    statusEl.style.display = "block";
    statusEl.className = "alert-success";
    statusEl.textContent = `✓ All images successfully processed and ready!`;
    setTimeout(() => {
      if (statusEl.classList.contains("alert-success")) statusEl.style.display = "none";
    }, 3000);
  }
}

/**
 * Add image directly via URL
 */
export function addImageByUrl() {
  const urlInput = document.getElementById("image-url-input");
  if (!urlInput) return;
  const url = urlInput.value.trim();
  if (!url) {
    alert("Please enter a valid image URL (e.g. https://... or ./image.jpg)");
    return;
  }

  uploadedImages.push({
    url: url,
    isMain: uploadedImages.length === 0,
    name: url.split("/").pop().slice(0, 24) || "External Image",
    size: "URL",
    isUploading: false,
    progress: 100
  });

  urlInput.value = "";
  renderUploadedImages();
}

/**
 * Render the image preview cards
 */
function renderUploadedImages() {
  const container = document.getElementById("uploaded-images-grid");
  if (!container) return;

  if (uploadedImages.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 2rem; color: #9CA3AF; border: 2px dashed #E5E7EB; border-radius: 8px;">
        No product images uploaded yet. Upload at least 1-3 images or provide an image URL.
      </div>
    `;
    updateVariantImageOptions();
    return;
  }

  let html = "";
  uploadedImages.forEach((img, idx) => {
    html += `
      <div class="image-preview-card ${img.isMain ? 'is-main' : ''}" style="position: relative; border: 2px solid ${img.isMain ? '#D4AF37' : '#E5E7EB'}; border-radius: 8px; overflow: hidden; background: #FFF; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
        ${img.isMain ? '<span style="position: absolute; top: 6px; left: 6px; background: #D4AF37; color: #FFF; font-size: 0.68rem; font-weight: 800; padding: 0.15rem 0.45rem; border-radius: 4px; z-index: 2;">★ MAIN</span>' : ''}
        
        <div style="height: 140px; background: #F9FAFB; display: flex; align-items: center; justify-content: center; overflow: hidden;">
          ${img.isUploading 
            ? `<div style="text-align: center; padding: 1rem;"><div style="font-size: 1.2rem;">⏳</div><div style="font-size: 0.75rem; color: #6B7280; margin-top: 0.25rem;">${img.progress}%</div></div>`
            : `<img src="${img.url}" alt="Preview" style="width: 100%; height: 100%; object-fit: contain;" onerror="this.src='./icon-192.png'">`
          }
        </div>

        <div style="padding: 0.5rem; background: #FFF; border-top: 1px solid #F3F4F6;">
          <div style="font-size: 0.75rem; color: #4B5563; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 0.35rem;" title="${img.name}">
            ${img.name} (${img.size})
          </div>

          <div style="display: flex; gap: 0.25rem; justify-content: space-between; align-items: center;">
            <button type="button" class="btn btn-outline" style="padding: 0.2rem 0.45rem; font-size: 0.7rem; ${img.isMain ? 'background:#FEF3C7; color:#92400E; border-color:#D4AF37;' : ''}" onclick="window.setMainImage(${idx})" title="Set as Main Product Image">
              ${img.isMain ? '★ Main' : '☆ Make Main'}
            </button>

            <div style="display: flex; gap: 0.2rem;">
              <button type="button" class="btn btn-outline" style="padding: 0.2rem 0.4rem; font-size: 0.7rem;" onclick="window.moveImageOrder(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="Move Left">
                ◀
              </button>
              <button type="button" class="btn btn-outline" style="padding: 0.2rem 0.4rem; font-size: 0.7rem;" onclick="window.moveImageOrder(${idx}, 1)" ${idx === uploadedImages.length - 1 ? 'disabled' : ''} title="Move Right">
                ▶
              </button>
              <button type="button" class="btn btn-outline" style="padding: 0.2rem 0.4rem; font-size: 0.7rem; color: #DC2626; border-color: #FCA5A5;" onclick="window.removeUploadedImage(${idx})" title="Remove image">
                ✕
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  updateVariantImageOptions();
}

export function setMainImage(idx) {
  uploadedImages.forEach((img, i) => {
    img.isMain = i === idx;
  });
  renderUploadedImages();
}

export function removeUploadedImage(idx) {
  const wasMain = uploadedImages[idx]?.isMain;
  uploadedImages.splice(idx, 1);
  if (wasMain && uploadedImages.length > 0) {
    uploadedImages[0].isMain = true;
  }
  renderUploadedImages();
}

export function moveImageOrder(idx, dir) {
  const target = idx + dir;
  if (target < 0 || target >= uploadedImages.length) return;
  const temp = uploadedImages[idx];
  uploadedImages[idx] = uploadedImages[target];
  uploadedImages[target] = temp;
  renderUploadedImages();
}

function updateVariantImageOptions() {
  document.querySelectorAll(".variant-image-select").forEach(select => {
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Main Product Image --</option>';
    uploadedImages.forEach((img, i) => {
      const opt = document.createElement("option");
      opt.value = img.url;
      opt.textContent = `Image ${i + 1} (${img.name})`;
      if (currentVal === img.url) opt.selected = true;
      select.appendChild(opt);
    });
  });
}

/**
 * ===================================================
 * COLOUR VARIANTS SYSTEM CONTROLLER (Section 4)
 * ===================================================
 */

export function addColourVariant(defaultName = "", defaultHex = "#1E3A8A") {
  const id = `var-${Date.now()}-${colourVariants.length + 1}`;
  colourVariants.push({
    id,
    name: defaultName || `Colour ${colourVariants.length + 1}`,
    hex: defaultHex,
    stock: 5,
    sku: "",
    price: null,
    image: "",
    enabled: true
  });
  renderVariants();
  updateTotalVariantStock();
}

export function removeColourVariant(idx) {
  colourVariants.splice(idx, 1);
  renderVariants();
  updateTotalVariantStock();
}

export function addCommonColorVariant(name, hex) {
  addColourVariant(name, hex);
}

function renderVariants() {
  const container = document.getElementById("variants-list-container");
  const quickPalette = document.getElementById("variants-quick-palette");
  if (!container) return;

  // Render quick chips
  if (quickPalette && quickPalette.children.length === 0) {
    COMMON_COLORS.forEach(c => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "btn btn-outline";
      chip.style.padding = "0.3rem 0.65rem";
      chip.style.fontSize = "0.8rem";
      chip.style.display = "inline-flex";
      chip.style.alignItems = "center";
      chip.style.gap = "0.35rem";
      chip.innerHTML = `
        <span style="width: 12px; height: 12px; border-radius: 50%; background: ${c.hex}; border: 1px solid rgba(0,0,0,0.2);"></span>
        <span>${c.name}</span>
      `;
      chip.addEventListener("click", () => addCommonColorVariant(c.name, c.hex));
      quickPalette.appendChild(chip);
    });
  }

  if (colourVariants.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: #6B7280; background: #F9FAFB; border: 1px dashed #D1D5DB; border-radius: 8px;">
        No colour variants added. If this product comes in a single standard color, you can use the Base Stock above.<br>
        To offer multiple colours (e.g. Blue, Green, Yellow), click <strong>+ Add Colour Variant</strong> or choose a chip above.
      </div>
    `;
    updateTotalVariantStock();
    return;
  }

  let html = "";
  colourVariants.forEach((v, idx) => {
    html += `
      <div class="admin-card variant-row-card" style="margin-bottom: 0.85rem; padding: 1rem; border-left: 4px solid ${v.hex || '#D4AF37'}; background: ${v.enabled ? '#FFFFFF' : '#F9FAFB'};">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
          <div style="display: flex; align-items: center; gap: 0.6rem;">
            <input type="color" value="${v.hex || '#111111'}" style="width: 32px; height: 32px; border: none; border-radius: 6px; cursor: pointer; padding: 0;" onchange="window.updateVariantField(${idx}, 'hex', this.value)">
            <input type="text" value="${v.name}" placeholder="Colour Name (e.g. Royal Blue)" style="font-weight: 700; font-size: 0.95rem; padding: 0.35rem 0.6rem; border: 1.5px solid #D1D5DB; border-radius: 6px;" onchange="window.updateVariantField(${idx}, 'name', this.value)">
          </div>

          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <label style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.85rem; cursor: pointer;">
              <input type="checkbox" ${v.enabled ? 'checked' : ''} onchange="window.updateVariantField(${idx}, 'enabled', this.checked)">
              <span>Enabled</span>
            </label>
            <button type="button" class="btn btn-outline" style="padding: 0.25rem 0.6rem; font-size: 0.78rem; color: #DC2626; border-color: #FCA5A5;" onclick="window.removeColourVariant(${idx})">
              ✕ Remove
            </button>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; font-size: 0.85rem;">
          <div>
            <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">Stock Quantity *</label>
            <input type="number" min="0" value="${v.stock}" class="stock-input-field" style="width: 100%; text-align: left;" onchange="window.updateVariantField(${idx}, 'stock', parseInt(this.value, 10))">
          </div>

          <div>
            <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">Variant SKU (Optional)</label>
            <input type="text" value="${v.sku || ''}" placeholder="e.g. LS-BLUE-01" style="width: 100%; padding: 0.4rem 0.5rem; border: 1.5px solid #D1D5DB; border-radius: 6px;" onchange="window.updateVariantField(${idx}, 'sku', this.value)">
          </div>

          <div>
            <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">Variant Price (PKR, Optional)</label>
            <input type="number" min="0" value="${v.price || ''}" placeholder="Defaults to selling price" style="width: 100%; padding: 0.4rem 0.5rem; border: 1.5px solid #D1D5DB; border-radius: 6px;" onchange="window.updateVariantField(${idx}, 'price', parseFloat(this.value) || null)">
          </div>

          <div>
            <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">Specific Image</label>
            <select class="variant-image-select" style="width: 100%; padding: 0.4rem 0.5rem; border: 1.5px solid #D1D5DB; border-radius: 6px; font-size: 0.82rem;" onchange="window.updateVariantField(${idx}, 'image', this.value)">
              <option value="">-- Main Product Image --</option>
              ${uploadedImages.map((img, i) => `<option value="${img.url}" ${v.image === img.url ? 'selected' : ''}>Image ${i + 1} (${img.name})</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  updateTotalVariantStock();
}

export function updateVariantField(idx, field, value) {
  if (!colourVariants[idx]) return;
  colourVariants[idx][field] = value;
  if (field === "stock" || field === "enabled") {
    updateTotalVariantStock();
  }
}

function updateTotalVariantStock() {
  const banner = document.getElementById("total-variant-stock-banner");
  const baseStockInput = document.getElementById("product-stock-input");
  if (!banner) return;

  if (colourVariants.length > 0) {
    const total = colourVariants
      .filter(v => v.enabled !== false)
      .reduce((sum, v) => sum + (parseInt(v.stock, 10) || 0), 0);
    const enabledCount = colourVariants.filter(v => v.enabled !== false).length;

    banner.style.display = "block";
    banner.innerHTML = `
      <strong>Variant Stock Calculation:</strong> Total of <strong>${total} items</strong> across ${enabledCount} active colour variant(s).
      The total stock will be automatically synchronized with your colour inventory.
    `;
    if (baseStockInput) {
      baseStockInput.value = total;
      baseStockInput.disabled = true;
      baseStockInput.title = "Calculated from Colour Variants";
    }
  } else {
    banner.style.display = "none";
    if (baseStockInput) {
      baseStockInput.disabled = false;
      baseStockInput.title = "";
    }
  }
}

/**
 * ===================================================
 * FEATURES / SPECIFICATIONS LIST
 * ===================================================
 */

export function addFeatureBullet(text = "") {
  featuresList.push(text || "");
  renderFeatures();
}

export function removeFeatureBullet(idx) {
  featuresList.splice(idx, 1);
  renderFeatures();
}

function renderFeatures() {
  const container = document.getElementById("features-list-container");
  if (!container) return;

  if (featuresList.length === 0) {
    container.innerHTML = `<p style="font-size: 0.82rem; color: #9CA3AF; margin: 0 0 0.5rem;">No features added yet. Click "+ Add Bullet Point" to add product highlights.</p>`;
    return;
  }

  let html = "";
  featuresList.forEach((f, idx) => {
    html += `
      <div style="display: flex; gap: 0.5rem; margin-bottom: 0.4rem; align-items: center;">
        <span style="color: #D4AF37; font-weight: 700;">•</span>
        <input type="text" value="${f}" placeholder="e.g. 3-Piece Unstitched Lawn Suit with Voil Dupatta" style="flex: 1; padding: 0.35rem 0.5rem; border: 1.5px solid #D1D5DB; border-radius: 6px; font-size: 0.88rem;" onchange="window.updateFeatureText(${idx}, this.value)">
        <button type="button" class="btn btn-outline" style="padding: 0.2rem 0.45rem; color: #DC2626; border-color: #FCA5A5; font-size: 0.75rem;" onclick="window.removeFeatureBullet(${idx})">✕</button>
      </div>
    `;
  });
  container.innerHTML = html;
}

export function updateFeatureText(idx, val) {
  if (featuresList[idx] !== undefined) {
    featuresList[idx] = val;
  }
}

/**
 * ===================================================
 * AI INTEGRATIONS (Sections 7 & 8)
 * ===================================================
 */

export async function generateAiSeo() {
  const name = document.getElementById("product-name-input")?.value?.trim();
  const category = document.getElementById("product-category-input")?.value?.trim();
  const fabric = document.getElementById("product-fabric-input")?.value?.trim();
  const price = document.getElementById("product-price-input")?.value?.trim();
  const desc = document.getElementById("product-full-desc")?.value?.trim();
  const btn = document.getElementById("btn-generate-ai-seo");

  if (!name) {
    alert("Please enter a Product Name first so AI can generate relevant SEO metadata.");
    document.getElementById("product-name-input")?.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "✨ Generating SEO with AI...";
  }

  try {
    const res = await fetch("/api/seo/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productName: name,
        category,
        fabric,
        features: featuresList,
        price: parseFloat(price) || 0,
        description: desc
      })
    });

    const result = await res.json();
    if (result && result.success && result.data) {
      const data = result.data;
      if (document.getElementById("product-seo-title")) document.getElementById("product-seo-title").value = data.metaTitle || "";
      if (document.getElementById("product-seo-desc")) document.getElementById("product-seo-desc").value = data.metaDescription || "";
      if (document.getElementById("product-seo-keyword")) document.getElementById("product-seo-keyword").value = data.focusKeyword || "";
      if (document.getElementById("product-seo-additional-keywords")) document.getElementById("product-seo-additional-keywords").value = data.additionalKeywords || "";
      if (document.getElementById("product-seo-og-title")) document.getElementById("product-seo-og-title").value = data.ogTitle || "";
      if (document.getElementById("product-seo-og-desc")) document.getElementById("product-seo-og-desc").value = data.ogDescription || "";

      setupCharCounters();
      alert("✓ SEO metadata generated successfully! You can review and customize any field.");
    } else {
      alert("Could not generate SEO: " + (result?.error || "Unknown server response"));
    }
  } catch (err) {
    console.error("AI SEO error:", err);
    alert("Error calling AI SEO service: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✨ Generate SEO with AI";
    }
  }
}

export async function generateAiDescription() {
  const name = document.getElementById("product-name-input")?.value?.trim();
  const category = document.getElementById("product-category-input")?.value?.trim();
  const fabric = document.getElementById("product-fabric-input")?.value?.trim();
  const btn = document.getElementById("btn-generate-ai-desc");

  if (!name) {
    alert("Please enter a Product Name first so AI can generate product descriptions.");
    document.getElementById("product-name-input")?.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "✨ Writing Description with AI...";
  }

  try {
    const res = await fetch("/api/description/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productName: name,
        category,
        fabric,
        features: featuresList
      })
    });

    const result = await res.json();
    if (result && result.success && result.data) {
      const data = result.data;
      if (document.getElementById("product-heading-input")) document.getElementById("product-heading-input").value = data.heading || "";
      if (document.getElementById("product-short-desc")) document.getElementById("product-short-desc").value = data.shortSummary || "";
      if (document.getElementById("product-full-desc")) document.getElementById("product-full-desc").value = data.fullDescription || "";

      if (Array.isArray(data.features) && data.features.length > 0) {
        featuresList = data.features;
        renderFeatures();
      }

      alert("✓ Description generated successfully! You can freely edit and refine before saving.");
    } else {
      alert("Could not generate description: " + (result?.error || "Unknown response"));
    }
  } catch (err) {
    console.error("AI Description error:", err);
    alert("Error calling AI service: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✨ Generate Description with AI";
    }
  }
}

/**
 * ===================================================
 * SAVE PRODUCT WORKFLOW (Section 9)
 * ===================================================
 */

export async function saveProductForm(forcedStatus = null) {
  const name = document.getElementById("product-name-input")?.value?.trim();
  let slug = document.getElementById("product-slug-input")?.value?.trim();
  const category = document.getElementById("product-category-input")?.value?.trim();
  const priceRaw = document.getElementById("product-price-input")?.value;
  const cutPriceRaw = document.getElementById("product-cut-price-input")?.value;
  const baseStockRaw = document.getElementById("product-stock-input")?.value;
  const brand = document.getElementById("product-brand-input")?.value?.trim() || "ZENVORA SHOOP";
  const sku = document.getElementById("product-sku-input")?.value?.trim();
  const fabric = document.getElementById("product-fabric-input")?.value?.trim();
  const heading = document.getElementById("product-heading-input")?.value?.trim();
  const shortDesc = document.getElementById("product-short-desc")?.value?.trim();
  const fullDesc = document.getElementById("product-full-desc")?.value?.trim();
  const shippingInfo = document.getElementById("product-shipping-input")?.value?.trim();
  const isFeatured = document.getElementById("product-featured-checkbox")?.checked || false;

  const seoTitle = document.getElementById("product-seo-title")?.value?.trim();
  const seoDesc = document.getElementById("product-seo-desc")?.value?.trim();
  const seoKeyword = document.getElementById("product-seo-keyword")?.value?.trim();
  const seoAdditional = document.getElementById("product-seo-additional-keywords")?.value?.trim();
  const seoOgTitle = document.getElementById("product-seo-og-title")?.value?.trim();
  const seoOgDesc = document.getElementById("product-seo-og-desc")?.value?.trim();

  const statusRadio = document.querySelector('input[name="product-status-radio"]:checked')?.value || "published";
  const targetStatus = forcedStatus || statusRadio;

  // Validate Required Fields
  if (!name) {
    alert("Product Name is required.");
    document.getElementById("product-name-input")?.focus();
    return;
  }

  if (!slug) {
    slug = generateProductSlug(name);
  } else {
    slug = generateProductSlug(slug);
  }

  const price = parseFloat(priceRaw);
  if (isNaN(price) || price < 0) {
    alert("Please enter a valid Selling Price in PKR.");
    document.getElementById("product-price-input")?.focus();
    return;
  }

  const cutPrice = parseFloat(cutPriceRaw);
  if (!isNaN(cutPrice) && cutPrice > 0 && cutPrice <= price) {
    alert("Original / Cut Price must be greater than the Selling Price to display a discount.");
    document.getElementById("product-cut-price-input")?.focus();
    return;
  }

  // Validate Images
  if (uploadedImages.length === 0) {
    alert("Please upload at least one product image or provide an image URL.");
    document.getElementById("image-dropzone")?.scrollIntoView({ behavior: "smooth" });
    return;
  }

  const mainImgObj = uploadedImages.find(img => img.isMain) || uploadedImages[0];
  const mainImgUrl = mainImgObj ? mainImgObj.url : "";
  const allImgUrls = uploadedImages.map(img => img.url).filter(Boolean);

  // Validate Variants
  let finalStock = parseInt(baseStockRaw, 10) || 0;
  if (colourVariants.length > 0) {
    for (const v of colourVariants) {
      if (!v.name || !String(v.name).trim()) {
        alert("Each colour variant must have a valid Colour Name.");
        return;
      }
      if (isNaN(parseInt(v.stock, 10)) || parseInt(v.stock, 10) < 0) {
        alert(`Please specify a valid non-negative stock quantity for variant "${v.name}".`);
        return;
      }
    }
    finalStock = colourVariants
      .filter(v => v.enabled !== false)
      .reduce((sum, v) => sum + (parseInt(v.stock, 10) || 0), 0);
  }

  // Selected Sizes
  const selectedSizes = [];
  document.querySelectorAll(".size-checkbox:checked").forEach(cb => {
    selectedSizes.push(cb.value);
  });

  const payload = {
    productId: currentEditingProductId || slug,
    productName: name,
    slug: slug,
    category: category || "Fashion",
    price,
    originalPrice: (!isNaN(cutPrice) && cutPrice > price) ? cutPrice : null,
    stock: finalStock,
    status: targetStatus,
    image: mainImgUrl,
    images: allImgUrls,
    variants: colourVariants,
    sizes: selectedSizes,
    brand,
    sku,
    fabric,
    heading,
    shortDescription: shortDesc,
    description: fullDesc,
    features: featuresList.filter(Boolean),
    isFeatured,
    shippingInfo: shippingInfo || "Fast doorstep delivery across Karachi (2-3 days). Cash on Delivery available.",
    seo: {
      metaTitle: seoTitle || `${name} | ZENVORA SHOOP`,
      metaDescription: seoDesc || `Shop ${name} at ZENVORA SHOOP with Cash on Delivery Pakistan & WhatsApp orders.`,
      focusKeyword: seoKeyword || name.toLowerCase(),
      additionalKeywords: seoAdditional || "",
      canonicalUrl: `https://zenvorashoop.netlify.app/product.html?id=${currentEditingProductId || slug}`,
      ogTitle: seoOgTitle || `${name} | ZENVORA SHOOP`,
      ogDescription: seoOgDesc || `Shop authentic ${name} at ZENVORA SHOOP.`,
      ogImage: mainImgUrl
    }
  };

  const saveBtn = document.getElementById("btn-save-product-main");
  const origText = saveBtn ? saveBtn.textContent : "Save Product";
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving to Firestore...";
  }

  try {
    if (currentEditingProductId) {
      await updateProduct(currentEditingProductId, payload);
      showSaveSuccessBanner(payload, true);
    } else {
      await createProduct(payload);
      showSaveSuccessBanner(payload, false);
      currentEditingProductId = payload.productId;
    }

    loadCatalogueTable();
  } catch (err) {
    console.error("Save product error:", err);
    alert("Error saving product: " + (err.message || "Unknown Firestore error"));
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = origText;
    }
  }
}

function showSaveSuccessBanner(product, isUpdate) {
  const banner = document.getElementById("product-save-status-banner");
  if (!banner) return;

  const previewUrl = `product.html?id=${product.productId}`;
  banner.style.display = "block";
  banner.className = "alert-success";
  banner.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
      <div>
        <strong>✓ Product ${isUpdate ? 'Updated' : 'Created & Saved'} Successfully!</strong>
        <div style="font-size: 0.85rem; margin-top: 0.2rem;">
          Product "${product.productName}" is now active in Firestore with status: <strong>${product.status.toUpperCase()}</strong>.
        </div>
      </div>
      <div style="display: flex; gap: 0.5rem;">
        <a href="${previewUrl}" target="_blank" class="btn btn-outline" style="padding: 0.35rem 0.85rem; font-size: 0.8rem; background: #FFF;">
          👁️ Preview Dynamic Page
        </a>
        <button type="button" class="btn btn-dark" style="padding: 0.35rem 0.85rem; font-size: 0.8rem;" onclick="window.resetProductForm()">
          ＋ Add Another Product
        </button>
      </div>
    </div>
  `;

  banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export function resetProductForm() {
  currentEditingProductId = null;
  uploadedImages = [];
  colourVariants = [];
  featuresList = [];

  document.getElementById("add-product-form")?.reset();
  if (document.getElementById("product-slug-input")) document.getElementById("product-slug-input").value = "";
  if (document.getElementById("form-mode-title")) document.getElementById("form-mode-title").textContent = "Add New Product";
  if (document.getElementById("btn-save-product-main")) document.getElementById("btn-save-product-main").textContent = "Save & Publish Product";
  if (document.getElementById("product-save-status-banner")) document.getElementById("product-save-status-banner").style.display = "none";

  renderUploadedImages();
  renderVariants();
  renderFeatures();
  updateTotalVariantStock();
  updateCanonicalPreview("");
}

export function previewProductFromForm() {
  const slug = currentEditingProductId || document.getElementById("product-slug-input")?.value?.trim() || "preview";
  window.open(`product.html?id=${slug}`, "_blank");
}

/**
 * ===================================================
 * CATALOGUE & MANAGEMENT TABLE (Section 13)
 * ===================================================
 */

export function loadCatalogueTable() {
  const tbody = document.getElementById("catalogue-table-body");
  if (!tbody) return;

  subscribeToProducts((products) => {
    allAdminProducts = products;
    renderCatalogueRows(products);
  }, (err) => {
    console.warn("Products catalogue subscription notice:", err);
  });
}

export function filterCatalogueTable() {
  const search = (document.getElementById("catalogue-search-input")?.value || "").toLowerCase().trim();
  const statusFilter = document.getElementById("catalogue-status-filter")?.value || "all";

  const filtered = allAdminProducts.filter(p => {
    const matchSearch = !search || 
      (p.productName && p.productName.toLowerCase().includes(search)) ||
      (p.productId && p.productId.toLowerCase().includes(search)) ||
      (p.category && p.category.toLowerCase().includes(search));

    const status = p.status || "available";
    const matchStatus = statusFilter === "all" ||
      (statusFilter === "published" && status === "available") ||
      (statusFilter === "draft" && status === "draft") ||
      (statusFilter === "out_of_stock" && (status === "out_of_stock" || (typeof p.stock === "number" && p.stock <= 0)));

    return matchSearch && matchStatus;
  });

  renderCatalogueRows(filtered);
}

function renderCatalogueRows(products) {
  const tbody = document.getElementById("catalogue-table-body");
  const countBadge = document.getElementById("catalogue-count-badge");
  if (!tbody) return;

  if (countBadge) countBadge.textContent = `${products.length} Products`;

  if (!products || products.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 3rem; color: #6B7280;">
          No matching products found in catalogue.
        </td>
      </tr>
    `;
    return;
  }

  let html = "";
  products.forEach(p => {
    const stock = typeof p.stock === "number" ? p.stock : 0;
    const isDraft = p.status === "draft";
    const isOut = p.status === "out_of_stock" || stock <= 0;
    
    let statusBadge = '<span class="badge-in">Published</span>';
    if (isDraft) {
      statusBadge = '<span style="background: #FEF3C7; color: #92400E; padding: 0.2rem 0.5rem; border-radius: 9999px; font-size: 0.72rem; font-weight: 700;">Draft</span>';
    } else if (isOut) {
      statusBadge = '<span class="badge-out">Out of Stock</span>';
    }

    const varCount = Array.isArray(p.variants) ? p.variants.length : 0;
    const prodUrl = p.productUrl || `product.html?id=${p.productId}`;
    const prodImg = p.image || "./icon-192.png";

    html += `
      <tr id="admin-row-${p.productId}">
        <td>
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <img src="${prodImg}" alt="" style="width: 44px; height: 44px; object-fit: cover; border-radius: 6px; border: 1px solid #E5E7EB;" onerror="this.src='./icon-192.png'">
            <div>
              <div style="font-weight: 700; color: #111827;">${p.productName}</div>
              <div style="font-size: 0.75rem; color: #6B7280; font-family: monospace;">ID: ${p.productId}</div>
            </div>
          </div>
        </td>
        <td>${p.category || 'Fashion'}</td>
        <td style="font-weight: 700; color: #111827;">Rs. ${Number(p.price || 0).toLocaleString()}</td>
        <td>
          <div style="font-weight: 600;">${stock}</div>
          ${varCount > 0 ? `<span style="font-size: 0.72rem; background: #EDE9FE; color: #5B21B6; padding: 0.1rem 0.35rem; border-radius: 4px;">${varCount} Colours</span>` : ''}
        </td>
        <td>${statusBadge}</td>
        <td>
          <div style="display: flex; gap: 0.35rem; flex-wrap: wrap;">
            <button type="button" class="btn btn-outline" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="window.editProductInForm('${p.productId}')" title="Edit Product">
              ✏️ Edit
            </button>
            <a href="${prodUrl}" target="_blank" class="btn btn-outline" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;" title="Preview Product">
              👁️
            </a>
            <button type="button" class="btn btn-outline" style="padding: 0.25rem 0.6rem; font-size: 0.75rem; color: ${isDraft ? '#059669' : '#D97706'};" onclick="window.quickTogglePublish('${p.productId}', '${isDraft ? 'published' : 'draft'}')" title="${isDraft ? 'Publish' : 'Unpublish'}">
              ${isDraft ? '✓ Publish' : 'Unpublish'}
            </button>
            <button type="button" class="btn btn-outline" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; color: #DC2626; border-color: #FCA5A5;" onclick="window.safeDeleteProduct('${p.productId}')" title="Safe Delete Product">
              🗑️
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

/**
 * Edit Product in Form
 */
export async function editProductInForm(productId) {
  const p = allAdminProducts.find(x => x.productId === productId) || await getProduct(productId);
  if (!p) {
    alert("Product details could not be loaded.");
    return;
  }

  currentEditingProductId = p.productId;

  // Header update
  if (document.getElementById("form-mode-title")) {
    document.getElementById("form-mode-title").textContent = `Edit Product: ${p.productName}`;
  }
  if (document.getElementById("btn-save-product-main")) {
    document.getElementById("btn-save-product-main").textContent = "✓ Update Product";
  }

  // Populate basic inputs
  if (document.getElementById("product-name-input")) document.getElementById("product-name-input").value = p.productName || "";
  if (document.getElementById("product-slug-input")) document.getElementById("product-slug-input").value = p.slug || p.productId;
  if (document.getElementById("product-category-input")) document.getElementById("product-category-input").value = p.category || "Fashion";
  if (document.getElementById("product-price-input")) document.getElementById("product-price-input").value = p.price || 0;
  if (document.getElementById("product-cut-price-input")) document.getElementById("product-cut-price-input").value = p.originalPrice || "";
  if (document.getElementById("product-stock-input")) document.getElementById("product-stock-input").value = p.stock || 0;
  if (document.getElementById("product-brand-input")) document.getElementById("product-brand-input").value = p.brand || "ZENVORA SHOOP";
  if (document.getElementById("product-sku-input")) document.getElementById("product-sku-input").value = p.sku || "";
  if (document.getElementById("product-fabric-input")) document.getElementById("product-fabric-input").value = p.fabric || "";
  if (document.getElementById("product-heading-input")) document.getElementById("product-heading-input").value = p.heading || "";
  if (document.getElementById("product-short-desc")) document.getElementById("product-short-desc").value = p.shortDescription || "";
  if (document.getElementById("product-full-desc")) document.getElementById("product-full-desc").value = p.description || "";
  if (document.getElementById("product-shipping-input")) document.getElementById("product-shipping-input").value = p.shippingInfo || "";
  if (document.getElementById("product-featured-checkbox")) document.getElementById("product-featured-checkbox").checked = Boolean(p.isFeatured);

  // Status Radio
  const statusVal = p.status === "draft" ? "draft" : "published";
  const rad = document.querySelector(`input[name="product-status-radio"][value="${statusVal}"]`);
  if (rad) rad.checked = true;

  // Sizes Checkboxes
  const existingSizes = Array.isArray(p.sizes) ? p.sizes : [];
  document.querySelectorAll(".size-checkbox").forEach(cb => {
    cb.checked = existingSizes.includes(cb.value);
  });

  // Images
  uploadedImages = [];
  const rawImages = Array.isArray(p.images) && p.images.length > 0 ? p.images : (p.image ? [p.image] : []);
  rawImages.forEach((url, idx) => {
    uploadedImages.push({
      url,
      isMain: url === p.image || idx === 0,
      name: url.split("/").pop().slice(0, 20) || `Image ${idx + 1}`,
      size: "Saved",
      isUploading: false,
      progress: 100
    });
  });
  renderUploadedImages();

  // Variants
  colourVariants = Array.isArray(p.variants) ? JSON.parse(JSON.stringify(p.variants)) : [];
  renderVariants();

  // Features
  featuresList = Array.isArray(p.features) ? [...p.features] : [];
  renderFeatures();

  // SEO
  const seo = p.seo || {};
  if (document.getElementById("product-seo-title")) document.getElementById("product-seo-title").value = seo.metaTitle || "";
  if (document.getElementById("product-seo-desc")) document.getElementById("product-seo-desc").value = seo.metaDescription || "";
  if (document.getElementById("product-seo-keyword")) document.getElementById("product-seo-keyword").value = seo.focusKeyword || "";
  if (document.getElementById("product-seo-additional-keywords")) document.getElementById("product-seo-additional-keywords").value = seo.additionalKeywords || "";
  if (document.getElementById("product-seo-og-title")) document.getElementById("product-seo-og-title").value = seo.ogTitle || "";
  if (document.getElementById("product-seo-og-desc")) document.getElementById("product-seo-og-desc").value = seo.ogDescription || "";

  setupCharCounters();
  updateCanonicalPreview(p.slug || p.productId);

  // Scroll to form
  document.getElementById("add-product-form")?.scrollIntoView({ behavior: "smooth" });
}

/**
 * Quick Toggle Publish / Draft
 */
export async function quickTogglePublish(productId, newStatus) {
  try {
    await adminUpdateProduct(productId, { status: newStatus });
    loadCatalogueTable();
  } catch (err) {
    alert("Failed to update status: " + err.message);
  }
}

/**
 * Safe Delete Product (checks orders)
 */
export async function safeDeleteProduct(productId) {
  const p = allAdminProducts.find(x => x.productId === productId);
  const name = p ? p.productName : productId;

  const orderCheck = await checkProductHasOrders(productId);
  if (orderCheck.hasOrders) {
    const confirmArchive = confirm(
      `Product "${name}" is referenced in ${orderCheck.orderCount} customer order(s) (e.g. #${orderCheck.recentOrderId}).\n\nDeleting this product would break past order records and customer order tracking.\n\nWould you like to UNPUBLISH / DRAFT this product instead so customers cannot buy it while preserving order history?`
    );
    if (confirmArchive) {
      await quickTogglePublish(productId, "draft");
      alert(`"${name}" has been set to Draft and hidden from the storefront.`);
    }
    return;
  }

  if (!confirm(`Are you sure you want to permanently delete "${name}" from the database? This cannot be undone.`)) {
    return;
  }

  try {
    await deleteProduct(productId, true);
    alert(`Product "${name}" deleted.`);
    loadCatalogueTable();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

/**
 * ===================================================
 * TAB 1 VARIANT STOCK MODAL CONTROLLER
 * ===================================================
 */

let activeModalProduct = null;

export async function openVariantStockModal(productId) {
  const p = allAdminProducts.find(x => x.productId === productId) || await getProduct(productId);
  if (!p) return;
  activeModalProduct = p;

  const modal = document.getElementById("modal-variant-stock-editor");
  const title = document.getElementById("modal-variant-product-title");
  const container = document.getElementById("modal-variants-list");
  if (!modal || !container) return;

  if (title) title.textContent = `Variant Inventory: ${p.productName}`;

  const variants = Array.isArray(p.variants) ? p.variants : [];
  if (variants.length === 0) {
    container.innerHTML = `<p style="color: #6B7280; text-align: center; padding: 1.5rem;">This product does not currently have colour variants defined. You can add colour variants in the Add Product tab.</p>`;
  } else {
    let html = "";
    variants.forEach((v, idx) => {
      html += `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #F3F4F6; gap: 1rem;">
          <div style="display: flex; align-items: center; gap: 0.6rem;">
            <span style="width: 18px; height: 18px; border-radius: 50%; background: ${v.hex || '#111111'}; border: 1px solid rgba(0,0,0,0.15);"></span>
            <strong style="font-size: 0.95rem; color: #111827;">${v.name}</strong>
            ${v.sku ? `<span style="font-size: 0.75rem; color: #6B7280; font-family: monospace;">(${v.sku})</span>` : ''}
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <label style="font-size: 0.8rem; font-weight: 600;">Stock:</label>
            <input type="number" min="0" value="${v.stock}" class="stock-input-field modal-variant-stock-input" data-index="${idx}" style="width: 75px;">
          </div>
        </div>
      `;
    });
    container.innerHTML = html;
  }

  modal.classList.add("active");
}

export function closeVariantStockModal() {
  const modal = document.getElementById("modal-variant-stock-editor");
  if (modal) modal.classList.remove("active");
  activeModalProduct = null;
}

export async function saveVariantStockModal() {
  if (!activeModalProduct) return;
  const inputs = document.querySelectorAll(".modal-variant-stock-input");
  const updatedVariants = Array.isArray(activeModalProduct.variants) ? JSON.parse(JSON.stringify(activeModalProduct.variants)) : [];

  inputs.forEach(input => {
    const idx = parseInt(input.dataset.index, 10);
    const val = parseInt(input.value, 10);
    if (updatedVariants[idx] && !isNaN(val) && val >= 0) {
      updatedVariants[idx].stock = val;
      updatedVariants[idx].status = val <= 0 ? "out_of_stock" : "available";
    }
  });

  const saveBtn = document.getElementById("btn-save-modal-variants");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
  }

  try {
    await adminUpdateProduct(activeModalProduct.productId, {
      variants: updatedVariants
    });
    closeVariantStockModal();
    alert("✓ Variant stock updated successfully!");
  } catch (err) {
    alert("Error updating variant stock: " + err.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Changes";
    }
  }
}

// Attach globally for inline event handlers
if (typeof window !== "undefined") {
  window.initAddProductTab = initAddProductTab;
  window.handleImageUploadFiles = handleImageUploadFiles;
  window.addImageByUrl = addImageByUrl;
  window.setMainImage = setMainImage;
  window.removeUploadedImage = removeUploadedImage;
  window.moveImageOrder = moveImageOrder;
  window.addColourVariant = addColourVariant;
  window.removeColourVariant = removeColourVariant;
  window.updateVariantField = updateVariantField;
  window.addFeatureBullet = addFeatureBullet;
  window.removeFeatureBullet = removeFeatureBullet;
  window.updateFeatureText = updateFeatureText;
  window.generateAiSeo = generateAiSeo;
  window.generateAiDescription = generateAiDescription;
  window.saveProductForm = saveProductForm;
  window.resetProductForm = resetProductForm;
  window.previewProductFromForm = previewProductFromForm;
  window.loadCatalogueTable = loadCatalogueTable;
  window.filterCatalogueTable = filterCatalogueTable;
  window.editProductInForm = editProductInForm;
  window.quickTogglePublish = quickTogglePublish;
  window.safeDeleteProduct = safeDeleteProduct;
  window.openVariantStockModal = openVariantStockModal;
  window.closeVariantStockModal = closeVariantStockModal;
  window.saveVariantStockModal = saveVariantStockModal;
}
