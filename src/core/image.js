(function() {

  function Queue() {

    // callback storage
    this._methods = [];

    // reference to the response
    this._response = null;

    // all queues start off unflushed
    this._flushed = false;

  };

  Queue.prototype = {

    // adds callbacks to the queue
    add: function(fn) {

      // if the queue had been flushed, return immediately
      if (this._flushed) {

        // otherwise push it on the queue
        fn(this._response);

      } else {
        this._methods.push(fn);
      }

    },

    flush: function(resp) {

      // flush only ever happens once
      if (this._flushed) {
        return;
      }

      // store the response for subsequent calls after flush()
      this._response = resp;

      // mark that it's been flushed
      this._flushed = true;

      // shift 'em out and call 'em back
      while (this._methods[0]) {
        this._methods.shift()(resp);
      }

    }

  };

  ImageModel = cdb.core.Model.extend({
    defaults: {
      format: "png",
      zoom: 10,
      center: [0, 0],
      width:  320,
      height: 240
    }
  });

  var Image = function() {

    var self = this;

    this.model = new ImageModel();

    this.layers = [];

    var one = {
      "type": "mapnik",
      "options": {
        "sql": "select null::geometry the_geom_webmercator",
        "cartocss": "#layer {\n\tpolygon-fill: #FF3300;\n\tpolygon-opacity: 0;\n\tline-color: #333;\n\tline-width: 0;\n\tline-opacity: 0;\n}",
        "cartocss_version": "2.2.0"
      }
    };

    this.layers.push(one);

    options = {}

    this.options = _.defaults(options, {
      ajax: window.$ ? window.$.ajax : reqwest.compat,
      pngParams: ['map_key', 'api_key', 'cache_policy', 'updated_at'],
      gridParams: ['map_key', 'api_key', 'cache_policy', 'updated_at'],
      cors: this.isCORSSupported(),
      btoa: this.isBtoaSupported() ? this._encodeBase64Native : this._encodeBase64,
      MAX_GET_SIZE: 2033,
      force_cors: false,
      instanciateCallback: function() {
        return '_cdbc_' + self._callbackName();
      }
    });

    this.layerToken = null;
    this.urls = null;
    this.silent = false;
    this.interactionEnabled = []; //TODO: refactor, include inside layer
    this._layerTokenQueue = [];
    this._timeout = -1;
    this._queue = [];
    this._waiting = false;
    this.lastTimeUpdated = null;
    this._refreshTimer = -1;

    this.endpoint = "http://arce.cartodb.com/api/v1/map"; // TODO: replace with the real one

  };

  Image.prototype = _.extend({}, Map.prototype, {

    load: function(vizjson) {

      this.queue = new Queue;

      this.model.set("vizjson", vizjson);

      var self = this;

      cdb.image.Loader.get(vizjson, function(data){

        if (data) {

          var layer_definition = data.layers[1].options.layer_definition;

          layerDefinition = new LayerDefinition(layer_definition, data.layers[1].options);
          self.endpoint = "http://" + data.layers[1].options.user_name + ".cartodb.com/api/v1/map";

          self.model.set("zoom", data.zoom);
          self.model.set("center", JSON.parse(data.center));
          self.model.set("bounds", data.bounds);

          //console.log(layerDefinition.toJSON())

          self._requestPOST(layerDefinition.toJSON(), function(data) {

            if (data) {
              self.model.set("layergroupid", data.layergroupid)
              self.queue.flush(this);
            }

          });
        }

      });

      return this;

    },

    toJSON: function() {
      return this.layers[0];
    },

    loadLayerDefinition: function(layer_definition) {

      this.queue = new Queue;

      var self = this;

      layer_definition = {
        stat_tag: "2b13c956-e7c1-11e2-806b-5404a6a683d5",
        version: "1.0.1",
        layers: [{
          type: "http",
          options: {
            urlTemplate: "http://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
            subdomains: [ "a", "b", "c" ]
          }
        }, 
        {
          type: "cartodb",
          options: {
            sql: "select * from cities",
            cartocss: "/** simple visualization */ #cities{ marker-file: url(http://com.cartodb.users-assets.production.s3.amazonaws.com/maki-icons/music-18.svg); marker-fill-opacity: 0.8; marker-line-color: #FFFFFF; marker-line-width: 3; marker-line-opacity: .8; marker-placement: point; marker-type: ellipse; marker-width: 16; marker-fill: #6ac41c; marker-allow-overlap: true; }",
            cartocss_version: "2.1.1"
          }
        }]
      };

      console.log(layer_definition);

      this._requestPOST(layer_definition, function(data) {

        if (data) {

          self.model.set("layergroupid", data.layergroupid)
          //console.log(data.layergroupid);

          self.queue.flush(this);
        }

      });

    },

    _requestPOST: function(params, callback) {

      this.options.ajax({
        crossOrigin: true,
        type: 'POST',
        method: 'POST',
        dataType: 'json',
        contentType: 'application/json',
        url: this.endpoint,
        data: JSON.stringify(params),
        success: function(data) {
          callback(data);
        },
        error: function(xhr) {
          callback(null);
        }
      });

    },

    _tilerHost: function() {
      var opts = this.options;
      return opts.tiler_protocol +
        "://" + ((opts.user_name) ? opts.user_name+".":"")  +
      opts.tiler_domain +
        ((opts.tiler_port != "") ? (":" + opts.tiler_port) : "");
    },

    _host: function(subhost) {
      var opts = this.options;
      if (opts.no_cdn) {
        return this._tilerHost();
      } else {
        var h = opts.tiler_protocol + "://";
        if (subhost) {
          h += subhost + ".";
        }
        var cdn_host = opts.cdn_url || cdb.CDB_HOST;
        if(!cdn_host.http && !cdn_host.https) {
          throw new Error("cdn_host should contain http and/or https entries");
        }
        h += cdn_host[opts.tiler_protocol] + "/" + opts.user_name;
        return h;
      }
    },

    zoom: function(zoom) {

      var self = this;

      this.queue.add(function() {
        self.model.set({ zoom: zoom });
      });

      return this;

    },

    bbox: function(bbox) {

      var self = this;

      this.queue.add(function() {
        self.model.set({ bbox: bbox });
      });

      return this;

    },

    center: function(center) {

      var self = this;

      this.queue.add(function() {
        self.model.set({ center: center });
      });

      return this;

    },

    format: function(format) {

      var self = this;

      this.queue.add(function() {
        self.model.set({ format: format });
      });

      return this;

    },

    size: function(width, height) {

      var self = this;

      this.queue.add(function() {
        self.model.set({ width: width, height: height });
      });

      return this;

    },

    getUrl: function(callback) {

      var self = this;

      this.queue.add(function(response) {
        //console.log(response);
        //console.log(self.model.attributes)

        var o = [self.endpoint , "static/center" , self.model.get("layergroupid"), self.model.get("zoom"), self.model.get("center")[0], self.model.get("center")[1],self.model.get("width"), self.model.get("height") + "." + self.model.get("format")];

        console.log(o.join("/"));

        // document.write goes here
      });

    },

    write: function() {

      var self = this;

      this.queue.add(function() {
        console.log(1, self.model.attributes);
        // document.write goes here
      });

      return this;
    }


  })

  cdb.Image = function(data) {

    //var image = new cdb.image.Image();

    var image = new Image();

    //image.load(data);


    if (typeof data === 'string') {
      image.load(data);
    } else {
      image.loadLayerDefinition(data);
    }

    return image;

  };

  var ImageLoader = cdb.image.Loader = {

    queue: [],
    current: undefined,
    _script: null,
    head: null,

    loadScript: function(src) {
      var script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = src;
      script.async = true;
      if (!ImageLoader.head) {
        ImageLoader.head = document.getElementsByTagName('head')[0];
      }
      // defer the loading because IE9 loads in the same frame the script
      // so Loader._script is null
      setTimeout(function() {
        ImageLoader.head.appendChild(script);
      }, 0);
      return script;
    },

    get: function(url, callback) {
      if (!ImageLoader._script) {
        ImageLoader.current = callback;
        ImageLoader._script = ImageLoader.loadScript(url + (~url.indexOf('?') ? '&' : '?') + 'callback=vizjson2');
      } else {
        ImageLoader.queue.push([url, callback]);
      }
    },

    getPath: function(file) {
      var scripts = document.getElementsByTagName('script'),
      cartodbJsRe = /\/?cartodb[\-\._]?([\w\-\._]*)\.js\??/;
      for (i = 0, len = scripts.length; i < len; i++) {
        src = scripts[i].src;
        matches = src.match(cartodbJsRe);

        if (matches) {
          var bits = src.split('/');
          delete bits[bits.length - 1];
          return bits.join('/') + file;
        }
      }
      return null;
    },

    loadModule: function(modName) {
      var file = "cartodb.mod." + modName + (cartodb.DEBUG ? ".uncompressed.js" : ".js");
      var src = this.getPath(file);
      if (!src) {
        cartodb.log.error("can't find cartodb.js file");
      }
      ImageLoader.loadScript(src);
    }
  };

  window.vizjson2 = function(data) {
    ImageLoader.current && ImageLoader.current(data);
    // remove script
    ImageLoader.head.removeChild(ImageLoader._script);
    ImageLoader._script = null;
    // next element
    var a = ImageLoader.queue.shift();
    if (a) {
      ImageLoader.get(a[0], a[1]);
    }
  };
})();