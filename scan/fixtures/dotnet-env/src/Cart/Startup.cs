using System;
using Microsoft.Extensions.Configuration;

namespace Cart
{
    public class Startup
    {
        private const string RegionKey = "CART_REGION";

        public IConfiguration Configuration { get; }

        public void ConfigureServices()
        {
            string redis = Configuration["REDIS_ADDR"];
            var logging = Configuration.GetSection("Logging");
            var timeout = int.Parse(Configuration["Cache:TimeoutSeconds"] ?? "30");
            var region = Environment.GetEnvironmentVariable(RegionKey) ?? "eu";
            var secret = Environment.GetEnvironmentVariable("CART_SECRET") ?? throw new InvalidOperationException();
            var callback = $"{Configuration["PUBLIC_URL"]}/signin-oidc";
            Configuration["WRITTEN_KEY"] = "x";
            // Configuration["COMMENTED_KEY"]
        }
    }
}
