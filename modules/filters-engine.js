// File: modules/filters-engine.js

import { db, collection, getDocs, query, limit } from "./firebase-config.js";
import { normalizeTextForSearch } from "./helpers.js";

// ==========================================
// FILTER STATE & EXAM DEFINITIONS
// ==========================================
export const filterState = {
    language: 'All',
    class: 'All',
    author: 'All',
    year: 'All'
};

export const allAuthorsCache = new Set();
export const allYearsCache = new Set();

export const ALL_EXAM_CATEGORIES = [
    "All", "9th", "10th", "11th", "12th", "SSC", "Railway", "Defence", 
    "Banking", "Teaching", "UPSC", "Police", "State PSC / PCS", "State SSC", 
    "JEE", "NEET", "CUET", "GATE", "CAT / MBA", "CLAT / Law", 
    "UGC NET / JRF", "CA / CS / CMA", "Insurance", "General Reading"
];

// Clean exam dictionary: Bare single digits ("9", "10", "11", "12") removed
// to prevent matching random year digits, editions, or page numbers.
export const EXAM_CATEGORY_MAP = {
    "9th": ["CLASS 9", "CLASS 9TH", "9TH", "CBSE 9", "ICSE 9", "GRADE 9"],
    "10th": ["CLASS 10", "CLASS 10TH", "10TH", "MATRIC", "CBSE 10", "ICSE 10", "GRADE 10"],
    "11th": ["CLASS 11", "CLASS 11TH", "11TH", "CBSE 11", "ISC 11", "GRADE 11"],
    "12th": ["CLASS 12", "CLASS 12TH", "12TH", "INTER", "INTERMEDIATE", "CBSE 12", "ISC 12", "GRADE 12"],
    "SSC": ["SSC", "CGL", "CHSL", "MTS", "CPO", "GD", "CONSTABLE GD", "STENOGRAPHER", "SELECTION POST"],
    "Railway": ["RAILWAY", "RRB", "NTPC", "GROUP D", "ALP", "TECHNICIAN", "RPF", "LOCO PILOT"],
    "Defence": ["NDA", "CDS", "AFCAT", "NAVY", "ARMY", "AIRFORCE", "AGNIVEER", "DEFENCE", "CAPF"],
    "Banking": ["BANK", "IBPS", "SBI", "PO", "CLERK", "RBI", "NABARD", "BANKING"],
    "Teaching": ["CTET", "STET", "UPTET", "KVS", "NVS", "BPSC TRE", "TRE", "DSSSB", "TEACHING", "TET", "REET"],
    "UPSC": ["UPSC", "IAS", "IPS", "IFS", "CIVIL SERVICES", "CSE"],
    "Police": ["POLICE", "UP POLICE", "DELHI POLICE", "BIHAR POLICE", "SI", "CONSTABLE", "DAROGA", "SUB INSPECTOR"],
    "State PSC / PCS": ["BPSC", "UPPSC", "MPPSC", "STATE PSC", "PCS", "RAS", "JPSC", "WBPSC", "PSC", "HPSC", "UKPSC", "OPSC"],
    "State SSC": ["BSSC", "UPSSSC", "HSSC", "UKSSSC", "OSSSC", "STATE SSC", "JSSC"],
    "JEE": ["JEE", "IIT", "MAINS", "ADVANCED", "BITSAT"],
    "NEET": ["NEET", "MEDICAL", "AIIMS"],
    "CUET": ["CUET", "CUET UG", "CUET PG"],
    "GATE": ["GATE"],
    "CAT / MBA": ["CAT", "MBA", "XAT", "MAT", "SNAP", "CMAT"],
    "CLAT / Law": ["CLAT", "LAW", "AILET", "LL.B", "JUDICIARY"],
    "UGC NET / JRF": ["UGC NET", "NET", "JRF", "CSIR NET"],
    "CA / CS / CMA": ["CA", "CS", "CMA", "FOUNDATION"],
    "Insurance": ["LIC", "NIACL", "GIC", "OICL", "INSURANCE", "AAO", "ADO"],
    "General Reading": ["GENERAL", "NOVEL", "STORY", "MAGAZINE", "SELF HELP", "READING", "HISTORY", "MOTIVATION", "STATIC GK", "GENERAL KNOWLEDGE", "GS"]
};

// ==========================================
// DYNAMIC METADATA LOADERS (SESSION CACHED)
// ==========================================
export async function fetchGlobalFilterMetadata() {
    try {
        const cachedMeta = sessionStorage.getItem('spidy_filter_meta_cached');
        if (cachedMeta) {
            const parsed = JSON.parse(cachedMeta);
            if (Array.isArray(parsed.authors) && Array.isArray(parsed.years)) {
                parsed.authors.forEach(a => allAuthorsCache.add(a));
                parsed.years.forEach(y => allYearsCache.add(y));
                return;
            }
        }

        const booksRef = collection(db, "books");
        const snap = await getDocs(query(booksRef, limit(60)));
        snap.forEach(d => {
            const val = d.data();
            const a = (val.author || "").trim();
            if (a && a.toLowerCase() !== "unknown") allAuthorsCache.add(a);
            const y = (val.year || "").toString().trim();
            if (y && !isNaN(parseInt(y, 10))) allYearsCache.add(y);
        });

        sessionStorage.setItem('spidy_filter_meta_cached', JSON.stringify({
            authors: Array.from(allAuthorsCache),
            years: Array.from(allYearsCache)
        }));
    } catch (e) {
        // Fallback silently without throwing unhandled exceptions
    }
}

export function getDynamicAuthorList(booksData = []) {
    const authorsSet = new Set(allAuthorsCache);
    booksData.forEach(book => {
        const aName = (book.author || "").trim();
        if (aName && aName.toLowerCase() !== "unknown") {
            authorsSet.add(aName);
        }
    });
    const sorted = Array.from(authorsSet).sort((a, b) => a.localeCompare(b));
    return ["All", ...sorted];
}

export function getDynamicYearList(booksData = []) {
    const yearsSet = new Set(allYearsCache);
    booksData.forEach(book => {
        const y = (book.year || "").toString().trim();
        if (y && !isNaN(parseInt(y, 10))) {
            yearsSet.add(y);
        }
    });
    const sortedYears = Array.from(yearsSet).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    return ["All", ...sortedYears];
}

// ==========================================
// FILTER CONFIGURATION & MODAL HELPERS
// ==========================================
export function getFilterModalConfig(type, booksData = []) {
    if (type === 'class') {
        return {
            title: "Filter Exam / Board",
            sub: "SELECT EXAM / BOARD",
            themeClass: "theme-green",
            subIcon: `<svg class="subtitle-icon" viewBox="0 0 24 24"><path d="M22 10v6M2 10l10-5 10 5-10 5z"></path><path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5"></path></svg>`,
            options: ALL_EXAM_CATEGORIES
        };
    } else if (type === 'language') {
        return {
            title: "Filter Language",
            sub: "SELECT MEDIUM",
            themeClass: "theme-blue",
            subIcon: `<svg class="subtitle-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
            options: ["All", "Hindi", "English", "Bilingual"]
        };
    } else if (type === 'author') {
        return {
            title: "Filter Author",
            sub: "SELECT AUTHOR / FACULTY",
            themeClass: "theme-purple",
            subIcon: `<svg class="subtitle-icon" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
            options: getDynamicAuthorList(booksData)
        };
    } else if (type === 'year') {
        return {
            title: "Filter by Year",
            sub: "SELECT YEAR / EDITION",
            themeClass: "theme-amber",
            subIcon: `<svg class="subtitle-icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`,
            options: getDynamicYearList(booksData)
        };
    }
    return null;
}

export function openMainFilterModal() {
    const overlay = document.getElementById('mainFilterOverlay');
    if (!overlay) return;
    if (!overlay.classList.contains('active')) {
        if (!window.history.state || window.history.state.popup !== 'mainFilter') {
            window.history.pushState({ popup: 'mainFilter' }, '');
        }
        overlay.classList.add('active');
    }
}

export function closeMainFilterModal() {
    const overlay = document.getElementById('mainFilterOverlay');
    if (overlay) overlay.classList.remove('active');
}

export function closeSubFilterModal() {
    const subOverlay = document.getElementById('subFilterModalOverlay');
    if (subOverlay) subOverlay.classList.remove('active');
}

export function openSubFilterModal(type, booksData, onFilterApplyCallback) {
    const config = getFilterModalConfig(type, booksData);
    if (!config) return;

    const subOverlay = document.getElementById('subFilterModalOverlay');
    const centerCard = document.getElementById('centerModalCard');
    if (!subOverlay || !centerCard) return;

    centerCard.className = 'center-modal-card compact-fit-card ' + config.themeClass;
    document.getElementById('modalTitleText').innerText = config.title;
    document.getElementById('modalSubtitleIcon').innerHTML = config.subIcon;
    document.getElementById('modalSubText').innerText = config.sub;

    const grid = document.getElementById('modalGridContainer');
    grid.innerHTML = '';

    config.options.forEach(optText => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isSelected = filterState[type] === optText;
        btn.className = `pill-btn ${isSelected ? 'active-selected' : ''}`;
        btn.innerText = optText;
        btn.title = optText;

        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            filterState[type] = optText;

            const labelEl = document.getElementById(`label-${type}`);
            const boxEl = document.getElementById(`box-${type}`);

            if (labelEl) labelEl.innerText = optText;
            if (boxEl) {
                if (optText !== 'All') {
                    boxEl.classList.add('has-val');
                } else {
                    boxEl.classList.remove('has-val');
                }
            }

            closeSubFilterModal();
            if (window.history.state && window.history.state.popup === 'subFilter') {
                window.history.back();
            }

            if (typeof onFilterApplyCallback === 'function') {
                onFilterApplyCallback();
            }
        };

        grid.appendChild(btn);
    });

    if (!subOverlay.classList.contains('active')) {
        if (!window.history.state || window.history.state.popup !== 'subFilter') {
            window.history.pushState({ popup: 'subFilter', filterType: type }, '');
        }
        subOverlay.classList.add('active');
    }
}

// ==========================================
// STRICT WORD BOUNDARY & ACCURATE MATCHING ENGINE
// ==========================================
function regexEscape(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesExactWordOrPhrase(targetText, keyword) {
    if (!targetText || !keyword) return false;
    const cleanKw = regexEscape(keyword.trim().toUpperCase());
    if (!cleanKw) return false;

    const pattern = new RegExp(`(^|[^A-Z0-9])${cleanKw}([^A-Z0-9]|$)`, 'i');
    return pattern.test(targetText);
}

export function matchBookFilters(book, searchInputRaw, cleanSearchNoSpaces, searchWords) {
    // 1. Exam / Category Match
    let matchesCategory = true;
    if (filterState.class !== "All") {
        const examFields = `${book.exams || ''}`.toUpperCase();
        const titleFallback = `${book.title || ''}`.toUpperCase();
        const targetKeywords = EXAM_CATEGORY_MAP[filterState.class] || [filterState.class.toUpperCase()];

        let foundInExams = targetKeywords.some(kw => matchesExactWordOrPhrase(examFields, kw));
        if (!foundInExams) {
            foundInExams = targetKeywords.some(kw => matchesExactWordOrPhrase(titleFallback, kw));
        }
        matchesCategory = foundInExams;
    }

    // 2. Language Match
    let matchesLanguage = true;
    if (filterState.language !== "All") {
        const bookLang = (book.lang || "").toLowerCase().trim();
        const targetLang = filterState.language.toLowerCase().trim();
        matchesLanguage = bookLang === targetLang || bookLang.includes(targetLang);
    }

    // 3. Author Match
    let matchesAuthor = true;
    if (filterState.author !== "All") {
        matchesAuthor = (book.author || "").toLowerCase().trim() === filterState.author.toLowerCase().trim();
    }

    // 4. Year Match
    let matchesYear = true;
    if (filterState.year !== "All") {
        matchesYear = (book.year || "").toString().trim() === filterState.year.toString().trim();
    }

    // 5. Global Search Match
    let matchesSearch = true;
    if (searchInputRaw && searchInputRaw.length > 0) {
        const rawCombined = `${book.title || ''} ${book.author || ''} ${book.exams || ''}`.toLowerCase();
        const normalizedTarget = normalizeTextForSearch(rawCombined);

        const isNoSpaceMatch = cleanSearchNoSpaces && normalizedTarget.includes(cleanSearchNoSpaces);
        const isTokenMatch = searchWords.length > 0 && searchWords.every(word => rawCombined.includes(word));

        matchesSearch = isNoSpaceMatch || isTokenMatch;
    }

    return matchesCategory && matchesLanguage && matchesAuthor && matchesYear && matchesSearch;
}

// ==========================================
// INITIALIZE FILTER EVENT LISTENERS
// ==========================================
export function initFiltersEngine(getBooksDataCallback, onFilterApplyCallback) {
    document.getElementById('openAuthorFilterBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMainFilterModal();
    });

    document.getElementById('closeSubFilterBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.history.state && window.history.state.popup === 'subFilter') {
            window.history.back();
        } else {
            closeSubFilterModal();
        }
    });

    document.getElementById('mainFilterOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'mainFilterOverlay') {
            if (window.history.state && window.history.state.popup === 'mainFilter') {
                window.history.back();
            } else {
                closeMainFilterModal();
            }
        }
    });

    document.getElementById('subFilterModalOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'subFilterModalOverlay') {
            if (window.history.state && window.history.state.popup === 'subFilter') {
                window.history.back();
            } else {
                closeSubFilterModal();
            }
        }
    });

    document.getElementById('filterBoxLanguage')?.addEventListener('click', () => {
        openSubFilterModal('language', getBooksDataCallback(), onFilterApplyCallback);
    });
    document.getElementById('filterBoxClass')?.addEventListener('click', () => {
        openSubFilterModal('class', getBooksDataCallback(), onFilterApplyCallback);
    });
    document.getElementById('filterBoxAuthor')?.addEventListener('click', () => {
        openSubFilterModal('author', getBooksDataCallback(), onFilterApplyCallback);
    });
    document.getElementById('filterBoxYear')?.addEventListener('click', () => {
        openSubFilterModal('year', getBooksDataCallback(), onFilterApplyCallback);
    });

    const searchInputEl = document.getElementById('app-search-input'); 
    let searchTimeout;
    searchInputEl?.addEventListener('input', () => { 
        clearTimeout(searchTimeout); 
        searchTimeout = setTimeout(() => { 
            if (typeof onFilterApplyCallback === 'function') {
                onFilterApplyCallback(); 
            }
        }, 300); 
    });

    document.getElementById('close-search')?.addEventListener('click', () => { 
        if (searchInputEl) searchInputEl.value = ''; 
        if (typeof onFilterApplyCallback === 'function') {
            onFilterApplyCallback(); 
        }
        document.getElementById('search-box')?.classList.remove('active'); 
        if (window.history.state && window.history.state.popup === 'search') { 
            window.history.back(); 
        }
    });
}
