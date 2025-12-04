// regions-tags.js
import { inject, customElement, bindable, BindingEngine } from 'aurelia-framework';
import RegionsList from './regions-list';
import Context from '../app/context';
import { IVIEWER, ROI_TABS } from '../utils/constants';
import { forEach } from 'jszip';

@customElement('regions-tags')
@inject(Context, BindingEngine)
export default class RegionsTags extends RegionsList {

    @bindable tags = [];
    @bindable selectedTag = null;

    // constructor(context, bindingEngine) {
    //     super(context, bindingEngine);
    // }

    // bind() {
    //     super.bind();
    //     this.loadTags();
    // }

    // async loadTags() {
    //     // Fetch tags from the server
    //     const response = await fetch('/api/rois-by-tags/');
    //     const data = await response.json();
    //     this.tags = data;
    // }

    // async filterRoisByTag(tagId) {
    //     if (!tagId) return;

    //     // Fetch ROIs for the selected tag
    //     const response = await fetch(`/api/rois-by-tags/?tag_id=${tagId}`);
    //     const data = await response.json();

    //     // Assuming the data structure matches what you need
    //     this.regions_info.data = data.roi_list;
    // }

    // Override or extend other methods as needed

    /**
     * Hide/Shows tegions table
     *
     * @memberof RegionsList
     */
    toggleRegionsTable() {
        if ($('.regions-tag').is(':visible')) {
            $('.regions-tag').hide();
            $('.regions-tag-toggler').removeClass('collapse-up');
            $('.regions-tag-toggler').addClass('expand-down');
        } else {
            $('.regions-tag').show();
            $('.regions-tag-toggler').removeClass('expand-down');
            $('.regions-tag-toggler').addClass('collapse-up');
        }
    }

    /**
     * Show/Hide rois within tag
     *
     * @param {number} tag_id the tag id
     * @param {Event} event the browser's event object
     * @memberof RegionsList
     */
    expandOrCollapseTag(tag_id, event) {
        event.stopPropagation();

        this.tags.forEach((tag) => {
            if (tag['id'] === tag_id) {
                tag.show = !tag.show;
            }
        });
    }

    /**
     * When the regions_info changes, force load/refresh data
     * @param {RegionsInfo} newVal
     * @param {RegionsInfo} oldVal
     */
    regions_infoChanged(newVal, oldVal) {
        if (this.selected_roi_tab === ROI_TABS.ROI_TAGS) {
            this.requestData(true);
        }
    }

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

    tags = null;

    requestData(refresh=false) {
        if (this.tags != null && !refresh) {
            // Data already loaded
            return;
        }
        this.is_pending = true;
        $.ajax({
            url :
                this.context.server + this.context.getPrefixedURI(IVIEWER) +
                "/tags/" + this.regions_info.image_info.image_id + '/',
            success : (response) => {
                this.is_pending = false;
                this.tags = [];
                for (let t=0; t<response.length; t++) {
                    let tag = response[t];
                    // default tags expanded
                    tag.show = false;
                    let rois = tag["rois"];
                    tag["rois"] = [];
                    for (let r=0; r<rois.length; r++) {
                        tag["rois"].push(this.regions_info.data.get(rois[r]))
                    }
                    this.tags.push(tag);
                }
            },
            error : (error, textStatus) => {
                this.is_pending = false;
                if (typeof error.responseText === 'string') {
                    console.error(error.responseText);
                }
            }
        });
    }
}