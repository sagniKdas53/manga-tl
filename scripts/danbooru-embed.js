// ==UserScript==
// @name         Danbooru Universal Embed Notes
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Instantly displays translated notes by adapting to Danbooru's dynamic DOM structures.
// @author       Gemini
// @match        *://danbooru.donmai.us/posts/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=donmai.us
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Inject the CSS that forces the native notes to become visible white boxes
    const style = document.createElement('style');
    style.textContent = `
        body.quick-embedded-active .note-box {
            background-color: white !important;
            border: 1px solid #ccc !important;
            opacity: 1 !important;
            display: flex !important;
            z-index: 100 !important;
            background-image: none !important;
        }
        
        body.quick-embedded-active .note-box .note-box-inner-border {
            opacity: 1 !important;
            color: black !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            text-align: center !important;
            font-size: 14px !important;
            line-height: 1.2 !important;
            padding: 4px !important;
            width: 100% !important;
            height: 100% !important;
            box-sizing: border-box !important;
            border: none !important;
            white-space: pre-wrap !important;
            overflow: hidden !important;
            margin: 0 !important;
            background: transparent !important;
        }
        
        body.quick-embedded-active .note-body,
        body.quick-embedded-active #note-preview {
            display: none !important;
        }
    `;
    document.head.appendChild(style);

    function toggleLocalEmbed() {
        // Check if we are turning it on or off
        const isActivating = !document.body.classList.contains('quick-embedded-active');

        if (isActivating) {
            // Before showing, ensure all boxes are properly structured with the text inside them
            const noteBoxes = document.querySelectorAll('.note-box');
            noteBoxes.forEach(box => {
                let inner = box.querySelector('.note-box-inner-border');
                const body = box.nextElementSibling;

                // If Danbooru hasn't generated the inner border div yet, we create it.
                if (!inner) {
                    inner = document.createElement('div');
                    inner.className = 'note-box-inner-border';

                    // Pull the actual translation text from the adjacent note-body element
                    if (body && body.classList.contains('note-body')) {
                        inner.innerHTML = body.innerHTML;
                    }
                    box.appendChild(inner);
                }
            });
        }

        // Toggle the master CSS class on the body element
        document.body.classList.toggle('quick-embedded-active');
    }

    function init() {
        // Find the "Options" list in the sidebar
        const optionsList = document.querySelector('#post-options ul');
        if (!optionsList) return;

        // Create the new list item and clickable link
        const li = document.createElement('li');
        const toggleLink = document.createElement('a');
        toggleLink.href = '#';
        toggleLink.textContent = 'Toggle Embed Notes';
        toggleLink.style.fontWeight = 'bold';

        toggleLink.addEventListener('click', function (e) {
            e.preventDefault();
            toggleLocalEmbed();
        });

        li.appendChild(toggleLink);
        optionsList.insertBefore(li, optionsList.firstChild);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();