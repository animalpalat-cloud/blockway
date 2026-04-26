import { CtaSection }      from "@/components/landing/CtaSection";
import { FeaturesSection }  from "@/components/landing/FeaturesSection";
import { Footer }           from "@/components/landing/Footer";
import { HeroSection }      from "@/components/landing/HeroSection";
import { HowItWorksSection }from "@/components/landing/HowItWorksSection";
import { Navbar }           from "@/components/landing/Navbar";
import { PricingSection }   from "@/components/landing/PricingSection";
import { TrustSection }     from "@/components/landing/TrustSection";

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <Navbar />
      <main>
        <HeroSection />
        <FeaturesSection />
        <HowItWorksSection />
        <TrustSection />
        <PricingSection />
        <CtaSection />
      </main>
      <Footer />
    </div>
  );
}
