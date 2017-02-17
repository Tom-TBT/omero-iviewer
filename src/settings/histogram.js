import {noView} from 'aurelia-framework';
import Misc from '../utils/misc';
import {WEBGATEWAY} from '../utils/constants';
import ImageInfo from '../model/image_info';
import {
    IMAGE_SETTINGS_CHANGE, IMAGE_DIMENSION_CHANGE, HISTOGRAM_RANGE_UPDATE,
    EventSubscriber
} from '../events/events';
import * as d3 from 'd3';

/**
 * Histogram Functionality (no view, just code)
 */
@noView
export default class Histogram extends EventSubscriber {

    /**
     * an image_info reference
     * @memberof Histogram
     * @type {ImageInfo}
     */
    image_info = null;

    /**
     * a flag that prevents plotting when the histogram is not visible
     * i.e. checkbox is unchecked
     * @memberof Histogram
     * @type {boolean}
     */
    visible = false;

    /**
     * we piggyback onto image settings and dimensions changes
     * to get notified for channel property and dimension changes
     * that result in histogram/line plotting
     * for line updates due to range change we have a separate event
     * @memberof Histogram
     * @type {Array.<string,function>}
     */
    sub_list = [[IMAGE_SETTINGS_CHANGE,
                    (params={}) => this.handleSettingsChanges(params)],
                [IMAGE_DIMENSION_CHANGE,
                    (params={}) => this.handleSettingsChanges(params)],
                [HISTOGRAM_RANGE_UPDATE,
                    (params={}) => this.handleSettingsChanges(params)]];

    /**
     * the graph width/height
     * @memberof Histogram
     * @type {Array.<number>}
     */
    graph_dims = [300, 125];

    /**
     * data column number
     * @memberof Histogram
     * @type {Array.<number>}
     */
    graph_cols = 256;

    /**
     * the graph's svg element
     * @memberof Histogram
     * @type {SVGElement}
     */
    graph_svg = null;

    /**
     * last active channel which we have to remember
     * because the event doesn't contain that info
     * @memberof Histogram
     * @type {Array.<number>}
     */
    last_active_channel = null;

    /**
     * @constructor
     * @param {ImageInfo} image_info a reference to the image info
     * @param {string} selector selector for the element that holds the histogram
     */
    constructor(image_info=null, selector=".histogram") {
        super(image_info ? image_info.context.eventbus : null);

        // elementary check for image info existence and selector validity
        if (!(image_info instanceof ImageInfo) || $(selector).length === 0)
            return;

        // set members
        this.image_info = image_info;
        this.selector = selector;
        // set dims
        let el = $(this.selector);
        this.graph_dims[0] = el.width();
        this.graph_dims[1] = el.height();

        //subscribe to events that tell us whenever and what we need to re-plot
        this.subscribe();

        // we fire off a first request to check if backend supports histograms
        this.requestHistogramJson(0, ((data) => {
            if (this.image_info === null) return;
                this.image_info.has_histogram = (data !== null);
                if (this.image_info.has_histogram) this.createHistogramSVG(data);
            }));
    }

    /**
     * Creates the histogram
     * @param {Array} data the data (from the initial request)
     * @memberof Histogram
     */
    createHistogramSVG(data = null) {
        if (!this.image_info.has_histogram) return;

        // 1px margin to right so slider marker not lost
        this.graph_svg = d3.select($(this.selector).get(0)).append("svg")
              .attr("width", this.graph_dims[0] + 1)
              .attr("height", this.graph_dims[1])
              .append("g");

          // line plot
          this.graph_svg.append("g")
              .append("path")
              .attr("class", "histogram-line");

          // area fill
          this.graph_svg.append("path")
              .attr("class", "histogram-area")
              .attr('opacity', 0.5);

          // Add slider markers
          this.graph_svg.selectAll("rect")
              .data([0, 0])
              .enter().append("rect")
              .attr("y", 0)
              .attr("height", 300)
              .attr("width", 1)
              .attr("x", (d, i) => d * (this.graph_dims[1]/2));

         // plot histogram
         if (data) this.plotHistogram(0, data);
    }

    /**
     * Handles settings changes to affect plotting of the histogram/lines
     * @params {object} params the event params
     * @memberof Histogram
     */
    handleSettingsChanges(params = {}) {
        // find first active channel
        let channel = 0;
        if (Misc.isArray(this.image_info.channels))
            for (let i in this.image_info.channels)
                if (this.image_info.channels[i].active) {
                    channel = parseInt(i);
                    break;
                }

        // check whether we need to plot the entire histogram or just
        // the lines, in specific active, color and non channel changes (no prop)
        // such as time and plane changes are going to trigger the plotting
        // of the entire histogram (incl. backend request)
        let plotHistogram =
            (typeof params.prop !== 'string' ||
                params.prop === 'active' ||
                params.prop === 'color');

        // special case: active toggle that doesn't affect the first active channel
        if (plotHistogram && params.prop === "active" &&
                channel === this.last_active_channel) return;
        // update last active channel
        this.last_active_channel = channel;
        if (plotHistogram) this.plotHistogram(channel);
        else if (typeof params.channel === 'number' && // range change
                    typeof params.start === 'number' &&
                    typeof params.end === 'number' &&
                    params.channel === this.last_active_channel)
                this.plotHistogramLines(
                    params.channel, params.start, params.end);
        else this.plotHistogramLines(channel);
    }

    /**
     * Plots the histogram
     * @param {number} channel the channel index
     * @param {Array} data the data if it has already been requested
     *                      (e.g. on createHistogramSVG)
     * @memberof Histogram
     */
    plotHistogram(channel, data) {
        // we don't plot if we are not enabled or visible or haven't been
        // given a channel
        if (!this.image_info.has_histogram || !this.visible ||
                typeof channel !== 'number') return;

        if (typeof this.image_info.channels[channel] !== 'object') return;

        // color: if not valid, gray will be applied by default,
        // for white we choose black
        let color = "#" + this.image_info.channels[channel].color;
        if (color === "#FFFFFF") color = "#000000";

        // handler after successful backend data fetch
        let plotHandler = (data) => {
            // cache this for use by chartRange
            this.graph_cols = data.length;

            let x = d3.scaleLinear()
                .domain([0, data.length - 1])
                .range([0, this.graph_dims[0]]);

            let y = d3.scaleLinear()
                .domain([
                    d3.min(data),
                    d3.max(data)])
                .range([this.graph_dims[1], 0]);

            // line
            let line = d3.line()
                .x((d, i) => x(i))
                .y((d, i) => y(d));
            this.graph_svg.selectAll(".histogram-line")
                .datum(data)
                .attr("d", line)
                .attr('stroke', color);

            // area to fill under line
            let area = d3.area()
                .x((d, i) => x(i))
                .y0(this.graph_dims[1])
                .y1((d)=> y(d));
            this.graph_svg.selectAll(".histogram-area")
                .datum(data)
                .attr("class", "histogram-area")
                .attr("d", area)
                .attr('fill', color);

            // plot lines
            this.plotHistogramLines(channel);
        };

        // if we got data already (in the case of the initial request) => use it
        // otherwise issue the ajax request
        if (Misc.isArray(data)) plotHandler(data);
        else this.requestHistogramJson(channel, plotHandler);
    }

    /**
     * Plots the lines only
     * @param {number} channel the active channel index
     * @memberof Histogram
     */
    plotHistogramLines(channel, start, end) {
        // we don't plot if we are not enabled or visible
        // or weren't given a channel
        if (!this.image_info.has_histogram || !this.visible ||
            typeof this.image_info.channels[channel] !== 'object') return;

        let c = this.image_info.channels[channel];
        // color: if not valid, gray will be applied by default,
        // for white we choose black
        let color = "#" + c.color;
        if (color === "#FFFFFF") color = "#000000";

        if (typeof start !== 'number') start = c.window.start;
        if (typeof end !== 'number') end = c.window.end;
        let delta = c.window.max - c.window.min;
        let s = ((start - c.window.min) / delta) * this.graph_cols;
        let e = ((end - c.window.min) / delta) * this.graph_cols;

        this.graph_svg.selectAll("rect")
            .data([s, e])
            .attr("x", (d, i) => d * (this.graph_dims[0]/this.graph_cols))
            .attr('fill', color);
    }

    /**
     * Toggles Visibility
     * @memberof Histogram
     */
    toggleHistogramVisibilty(visible = false) {
        if (!this.image_info.has_histogram || typeof visible !== 'boolean') return;

        if (visible) {
            // if we were invisible => plot again with present settings
            if (!this.visible) {
                this.visible = true;
                this.handleSettingsChanges();
            }
            $(this.selector).show();
        }
        else {
            $(this.selector).hide();
            this.visible = false;
        }
    }

    /**
     * Requests Histogram Data
     * @param {number} channel the channel
     * @param {function} handler the success handler
     * @memberof Histogram
     */
    requestHistogramJson(channel = 0,handler = null) {
        // some bounds and existence checks
        // (unless for the initial request - no asyc image data present yet)
        if (Misc.isArray(this.image_info.channels) &&
                (typeof channel !== 'number' || channel < 0 ||
                channel > this.image_info.channels.length ||
                typeof handler !== 'function')) return;

        // assemble url
        let server = this.image_info.context.server;
        let uri_prefix = this.image_info.context.getPrefixedURI(WEBGATEWAY);
        let time = this.image_info.dimensions.t;
        let plane = this.image_info.dimensions.z;
        let url = server + uri_prefix + "/histogram_json/" +
            this.image_info.image_id + "/channel/" + channel + "/?theT=" +
            time + "&theZ="+ plane;

        // fire off ajax request
        $.ajax({url : url,
            success : (response) => {
                // for error and non array data (which is what we want)
                // we return null and the handler will respond accordingly
                let data =
                    typeof response === 'object' &&
                        Misc.isArray(response.data) ? response.data : null;
                handler(data);
            },
            error : () => handler(null)});
    }

    destroyHistogram() {
        this.unsubscribe();
        this.image_info = null;
    }
}
