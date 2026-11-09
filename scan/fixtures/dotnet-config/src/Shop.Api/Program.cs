var builder = WebApplication.CreateBuilder(args);
var ttl = builder.Configuration.GetValue<int>("Cache:Ttl", 60);
var region = builder.Configuration.GetValue<string>("Region");
var db = builder.Configuration.GetConnectionString("db");
builder.Services.Configure<EventBusOptions>(builder.Configuration.GetSection(SectionNames.EventBus));
var catalog = builder.Configuration.GetSection("Catalog").Get<CatalogOptions>();
builder.Services.AddOptions<PaymentOptions>()
    .BindConfiguration(nameof(PaymentOptions));
var identity = builder.Configuration.GetSection("Identity");
var audience = identity.GetValue<string>("Audience");
var auth = new AuthOptions();
identity.GetSection("Auth").Bind(auth);
builder.Configuration.GetSection("Logging");
var missing = builder.Configuration.GetSection("Missing").Get<MissingOptions>();
var other = builder.Configuration.GetSection(sectionName).Get<CatalogOptions>();
// builder.Configuration.GetValue<int>("Commented");
var app = builder.Build();
app.Run();
