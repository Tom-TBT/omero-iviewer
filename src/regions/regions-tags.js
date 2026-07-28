//
// Copyright (C) 2025 University of Dundee & Open Microscopy Environment.
// All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

import Context from '../app/context';
import { IVIEWER, ROI_TABS } from '../utils/constants';
import { inject, customElement, bindable } from 'aurelia-framework';

/**
 * Represents the regions tags sub-tab in the right hand panel
 */
@customElement('regions-tags')
@inject(Context)
export default class RegionsTags {
    /**
     * a bound reference to regions_info
     * @memberof RegionsTags
     * @type {RegionsInfo}
     */
    @bindable regions_info = null;

    /**
     * The current ROI sub-tab selected by the parent regions component
     */
    @bindable selected_roi_tab = null;

    /**
     * When the selected_roi_tab changes, load data (if not already loaded)
     * @param {String} newVal
     * @param {String} oldVal
     */
    selected_roi_tabChanged(newVal, oldVal) {
        if (this.selected_roi_tab === ROI_TABS.ROI_TAGS) {
            this.requestData();
        }
    }

    /**
     * Raw response from the image_tags endpoint
     * @type {Object}
     */
    tags_info = null;

    /**
     * tags_info.tagsets, as an array, for template iteration
     * @type {Array.<Object>}
     */
    tagsets_list = [];

    /**
     * tags_info.tags, as an array, for template iteration
     * @type {Array.<Object>}
     */
    tags_list = [];

    /**
     * Flag to indicate when we are loading data
     * @type {Boolean}
     */
    is_pending = false;

    /**
     * @constructor
     * @param {Context} context the application context (injected)
     */
    constructor(context) {
        this.context = context;
    }

    /**
     * Loads the tags/tagsets linked to the ROIs/Shapes of the current image
     * @param {Boolean} refresh if true we reload even if already loaded
     */
    requestData(refresh = false) {
        if (this.tags_info !== null && !refresh) return;
        this.is_pending = true;

        $.ajax({
            url:
                this.context.server + this.context.getPrefixedURI(IVIEWER) +
                '/image_tags/' + this.regions_info.image_info.image_id + '/',
            success: (response) => {
                this.is_pending = false;
                this.tags_info = response;
                this.tagsets_list = Object.values(response.tagsets);
                this.tags_list = Object.values(response.tags);
            },
            error: (error) => {
                this.is_pending = false;
                console.error("Failed to load tags: " + error);
            }
        });
    }
}
